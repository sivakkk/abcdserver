module.exports = function (synchronizer, service) {
    var config = require('../config/config')();
    var _async = require('async');
    var uuid = require('uuid/v1');
    var AWS = require('aws-sdk');
    var mongo = require('mongodb');
    var db = config.getDB();
    var gdriveHandlers = require('../handlers/storages/gdrive.js')(service);
    var s3Handlers = require('../handlers/storages/s3.js')(service);
    var azureHandlers = require('./storages/azure.js')(service);

    this.imageClassifiedCountHandler = function (request, h) {
        var promise = new Promise((resolve, reject) => {
            var result = {
                totalClassified : 0,
                totalImages : 0
            };
            var userId = '';

            var userType = request.auth.credentials.user.USER_TYPE;

            if((userType == config.get('USER_TYPE').SELF.NAME) || (userType == config.get('USER_TYPE').STUDENT_SELF.NAME) || (userType == config.get('USER_TYPE').ADMIN.NAME) || (userType == config.get('USER_TYPE').STUDENT_ADMIN.NAME)) {
                userId = request.auth.credentials.user._id;
            } else {
                userId = request.auth.credentials.admin._id;
            }

            _async.parallel([
                function (callback) {
                    db.collection(config.get('IMAGES_COLLECTION')).count({
                        USER_OID: new mongo.ObjectID(userId.toString()),
                        STATUS: 'CLASSIFIED',
                        PROJECT_ID : request.query.projectId
                    }, function (err, count) {
                        if (err)
                            callback(err)

                        else {
                            result.totalClassified = count;
                            callback(null);
                        }
                    });
                },
                function (callback) {
                    db.collection(config.get('IMAGES_COLLECTION')).count({
                        USER_OID: new mongo.ObjectID(userId.toString()),
                        PROJECT_ID : request.query.projectId
                    }, function (err, count) {
                    if (err)
                            callback(err);

                        else {
                            result.totalImages = count;
                            callback(null);
                        }
                    });
                }
            ], function (err) {
                if (err)
                    service.handleError(reject, err);

                else
                    resolve(result);
            });
        });

        return promise;
    }

    this.synchronizerHandler = function (request, h) {
        var promise = new Promise((resolve, reject) => {

            db.collection(config.get('USER_COLLECTION')).findOne({
                _id: new mongo.ObjectID(request.auth.credentials.user._id)
            }, function(err, user) {
                if(err) {
                    service.handleError(reject, err);
                } else if (!user) {
                    service.handleError(reject, `User does not exist!`);
                } else {

                    if(!user.PROJECTS[request.query.projectId]) {
                        service.handleError(reject, 'Invalid Project Id');
                        return;
                    }

                    if(!user.PROJECTS[request.query.projectId].ACTIVE_STORAGE || user.PROJECTS[request.query.projectId].ACTIVE_STORAGE == '') {
                        service.handleError(reject, 'No Active Storage for this project.');
                        return;
                    }

                    db.collection(config.get('IMAGES_COLLECTION')).count({
                        USER_OID: new mongo.ObjectID(request.auth.credentials.user._id)
                    }, function (err, count) {
                        if (err)
                            service.handleError(reject, err);

                        else {
                            if (user.SUBSCRIPTION_FLAG.LIMITS.IMAGE_LIMIT != -1 && user.SUBSCRIPTION_FLAG.LIMITS.IMAGE_LIMIT <= count)
                                service.handleError(reject, 'You have already exceeded the image limit. Please upgrade your account');

                            else {
                                resolve({
                                    message: 'done'
                                });
                                var data = {
                                    queueName: user._id,
                                    storage: user.PROJECTS[request.query.projectId].ACTIVE_STORAGE,
                                    userData: user,
                                    requestType: request.params.type,
                                    totalImageInAccount: count
                                };

                                //add sync code here
                                synchronizer.startSynchronizer(data, request.query.projectId);
                            }
                        }
                    });
                }
            })
        });

        return promise;
    }

    this.nextImageHandler = function (request, h) {
        var promise = new Promise((resolve, reject) => {
            db.collection(config.get('USER_COLLECTION')).findOne({
                _id: new mongo.ObjectId((request.auth.credentials.admin ? request.auth.credentials.admin._id : request.auth.credentials.user._id))
            }, function (err, user) {
                if(err) {
                    service.handleError(reject, err);
                    return;
                }
                else if(!user.PROJECTS[request.query.projectId]){
                    service.handleError(reject, 'Invalid Project Id');
                    return;
                }
                else {
                    if (request.auth.credentials.user.USER_TYPE == config.get('USER_TYPE').FREELANCER.NAME && request.auth.credentials.user.PROJECT_STATUS == 'TRAINING') {
                        this.nextFreelancerTrainingImageHandler(request, user)
                            .then( image => resolve(image))
                            .catch( error => service.handleError(reject, error));
                    }
                    else {
                        db.collection(config.get('IMAGES_COLLECTION')).findOne({
                            _id: new mongo.ObjectID(request.params.id)
                        }, function (err, item) {
                            if (err)
                                service.handleError(reject, err);

                            else if(!item)
                                service.handleError(reject, 'This image was not found');

                            else if(item.STATUS == 'CLASSIFIED' && request.query.edit != 'true')
                                service.handleError(reject, 'This image is already classified.');

                            else if (item.OBJECT_STORAGE_NAME == 'S3') {
                                var storageDetails = user.PROJECTS[request.query.projectId].STORAGE_DETAILS['S3'];

                                AWS.config.update({
                                    accessKeyId: storageDetails.ACCESS_KEY,
                                    secretAccessKey: storageDetails.SECRET_KEY,
                                    region: storageDetails.REGION_NAME
                                });

                                var s3 = new AWS.S3();

                                s3Handlers.getFileS3(request, s3, storageDetails.BUCKET_NAME, item.ORIGINAL_OBJECT_NAME).then(function (data) {
                                    resolve({
                                        data: data.content,
                                        id: item._id,
                                        IMAGE_WIDTH: data.dimension.width,
                                        IMAGE_HEIGHT: data.dimension.height
                                    });
                                }, function (err) {
                                    service.handleError(reject, err);
                                });
                            }

                            else if (item.OBJECT_STORAGE_NAME == "GOOGLE_DRIVE") {
                                gdriveHandlers.getFileGoogleDrive(item.ORIGINAL_OBJECT_NAME, item.OBJECT_NAME, request, db).then((data) => {
                                    resolve({
                                        data: data,
                                        id: item._id,
                                        IMAGE_WIDTH: item.IMAGE_WIDTH,
                                        IMAGE_HEIGHT: item.IMAGE_HEIGHT
                                    });
                                }, function (err) {
                                    service.handleError(reject, err);
                                });
                            }

                            else if (item.OBJECT_STORAGE_NAME == "AZURE_STORAGE") {
                                azureHandlers.getFileAzure(user, item.ORIGINAL_OBJECT_NAME, request.query.projectId, (err, data) => {
                                    if(err)
                                        service.handleError(reject, err);

                                    else {
                                        resolve({
                                            data: data.dataURI,
                                            id: item._id,
                                            IMAGE_WIDTH: data.width,
                                            IMAGE_HEIGHT: data.height
                                        });
                                    }
                                });
                            }
                        });
                    }
                }
            })
        });

        return promise;
    }

    this.progressHandler = function (request, h) {
        var promise = new Promise((resolve, reject) => {
            var collection = 'WORKING_IMAGES_COLLECTION';

            if (request.query.edit == 'true') {
                collection = 'CLASSIFIED_OBJECT_COLLECTION';
            }

            db.collection(config.get(collection)).findOne({
                OBJECT_OID: new mongo.ObjectID(request.params.objectId)
            }, function (err, item) {
                if (err)
                    service.handleError(reject, err);

                else if (item && item.LABEL_DETAILS) {
                    resolve({
                        data: item.LABEL_DETAILS,   // If image is working or classified image
                        SECONDS: item.SECONDS,      // If working image
                        MINUTES: item.MINUTES,      // If working image
                        HOURS: item.HOURS,          // If working image
                        CLASSIFICATION_TIME: item.CLASSIFICATION_TOTAL_TIME, // If classified image
                        IMAGE_HEIGHT: item.IMAGE_HEIGHT, // If classified image
                        IMAGE_WIDTH: item.IMAGE_WIDTH    // If classified image
                    });
                } else {
                    resolve({
                        data: new Array()
                    });
                }
            });
        });

        return promise;
    }

    this.schemaHandler = function (request, h) {
        var promise = new Promise(function(resolve, reject) {
            var query = {}
            var userType = request.auth.credentials.user.USER_TYPE;
            if((userType == config.get('USER_TYPE').SELF.NAME) || (userType == config.get('USER_TYPE').STUDENT_SELF.NAME) || (userType == config.get('USER_TYPE').ADMIN.NAME) || (userType == config.get('USER_TYPE').STUDENT_ADMIN.NAME))
                query['_id'] = new mongo.ObjectID(request.auth.credentials.user._id.toString());

            else
                query['_id'] = new mongo.ObjectID(request.auth.credentials.user.ADMIN_ID.toString());

            db.collection(config.get('USER_COLLECTION')).findOne(query, function (err, user) {
                if(err)
                    service.handleError(reject, err);

                else {
                    delete user.PASSWORD;

                    resolve(user);
                }
            });
        });

        return promise;
    }

    this.saveImageHandler = function (request, h) {
        var promise = new Promise((resolve, reject) => {
            request.payload = JSON.parse(request.payload);

            console.log('Payload', request.payload);

            if (userType === config.get('USER_TYPE').FREELANCER.NAME && request.auth.credentials.user.PROJECT_STATUS === 'TRAINING') {
                service.handleError(reject, 'Please complete the training first!');         // saveFreelancerTrainingImage function used to save freelancer training images
                return;
            }

            var timeInSeconds = (request.payload.hours * 3600) + (request.payload.minutes * 60) + request.payload.seconds;

            var data = {
                USER_OID: new mongo.ObjectID(request.auth.credentials.user._id.toString()),
                PROJECT_ID: request.payload.PROJECT_ID,
                OBJECT_OID: new mongo.ObjectID(request.payload.OBJECT_OID),
                LABEL_DETAILS: new Array(),
                IMAGE_WIDTH: request.payload.IMAGE_WIDTH,
                IMAGE_HEIGHT: request.payload.IMAGE_HEIGHT,
                CLASSIFICATION_START_DATE: new Date(request.payload.startTime).getTime(),
                CLASSIFICATION_END_DATE: new Date(request.payload.endTime).getTime(),
                CLASSIFICATION_TOTAL_TIME: timeInSeconds,
                UUID: uuid()
            }

            var userType = request.auth.credentials.user.USER_TYPE;

            if (userType === config.get('USER_TYPE').FREELANCER.NAME && request.auth.credentials.user.PROJECT_STATUS === 'ACTIVE') {
                data.VALIDATION_01 = false;
                data.VALIDATION_02 = false;
            }

            if((userType == config.get('USER_TYPE').SELF.NAME) || (userType == config.get('USER_TYPE').STUDENT_SELF.NAME) || (userType == config.get('USER_TYPE').ADMIN.NAME) || (userType == config.get('USER_TYPE').STUDENT_ADMIN.NAME)) {
                formatAnnotationData(data, request.payload.data, request.payload.projectType, request.auth.credentials.user.SUBSCRIPTION_FLAG.SHAPES);
            } else {
                formatAnnotationData(data, request.payload.data, request.payload.projectType, request.auth.credentials.admin.SUBSCRIPTION_FLAG.SHAPES);
            }

            var annotations = [];

            data['LABEL_DETAILS'].forEach(label => {
                var annotation = {};
                var labelName = {};
                for(key in label) {
                    if(key == "LABEL_NAME"){
                        labelName.LABEL = label[key];
                    }
                    else if(key !== "EDGES_POLY") {
                        label[key].forEach(rectangle => {
                            annotation = {...rectangle, ...labelName};
                            annotation.USER_OID = data.USER_OID;
                            annotation.PROJECT_ID = data.PROJECT_ID;
                            annotation.LABEL_TYPE = key;
                            annotations.push(annotation);
                            annotation = {};
                        })
                    }
                    else if(key == "EDGES_POLY"){
                        label[key].forEach(coordinates => {
                            for(k in coordinates) {
                                if(k == "COORDINATES"){
                                    var index = 0;
                                    coordinates[k].forEach(point => {
                                        annotation[`X_${index}`] = point.X;
                                        annotation[`Y_${index}`] = point.Y;
                                        annotation[`X_${index}_PERCENT`] = point.X_PERCENT;
                                        annotation[`Y_${index}_PERCENT`] = point.Y_PERCENT;
                                        index++;
                                    });
                                    annotation.USER_OID = data.USER_OID;
                                    annotation.PROJECT_ID = data.PROJECT_ID;
                                    annotation.LABEL_TYPE = key;
                                    annotations.push(annotation);
                                }
                            }
                        })
                    }
                }
            });

            var newImageData;

            _async.parallel([
                function(callback) {
                    if(userType === config.get('USER_TYPE').FREELANCER.NAME){
                        db.collection(config.get('ANNOTATION_COLLECTION')).insertMany(annotations, function(err, res){
                            if(err)
                                callback(err);
                            else {
                                callback(null);
                            }
                        });
                    } else {
                        callback(null);
                    }
                },
                function (callback) {
                    db.collection(config.get('WORKING_IMAGES_COLLECTION')).removeOne({
                        OBJECT_OID: new mongo.ObjectID(request.payload.OBJECT_OID)
                    }, function (err, res) {
                        if (err)
                            callback(err);

                        else {
                            console.log(res.result.n, 'objects removed from working collection');
                            console.log('Deleted Object from', config.get('WORKING_IMAGES_COLLECTION'));

                            callback(null);
                        }
                    });
                },
                function (callback) {
                    db.collection(config.get('CLASSIFIED_OBJECT_COLLECTION')).insertOne(data, function (err, res) {
                        if (err)
                            callback(err);

                        else {
                            // console.log('Fetching new image from ' + request.auth.credentials.user.ACTIVE_STORAGE);
                            service.checkClassifiedImageCount(request).then(() => {
                                service.getImageForClassifyScreen(request, request.auth.credentials.user, request.auth.credentials.admin, request.payload.PROJECT_ID, function (err, data) {
                                    if(err)
                                        callback(err);

                                    else {
                                        newImageData = data;

                                        callback(null);
                                    }
                                });
                            }).catch(err => callback(err));
                        }
                    });
                },
                function (callback) {
                    if (request.payload.ANNOTATE_BY && request.payload.ANNOTATE_BY === config.get('USER_TYPE').FREELANCER.NAME) {
                        db.collection(config.get('FREELANCER_VALIDATION_COLLECTION')).insertOne(data, function (err, res) {
                            if (err)
                                callback(err);

                            else {
                                console.log(res.insertedCount, 'records inserted in freelancer validation collection');
                                callback(null);
                            }
                        });
                    }

                    else
                        callback(null);
                },
                function (callback) {
                    db.collection(config.get('IMAGES_COLLECTION')).updateOne({
                        _id: new mongo.ObjectID(request.payload.OBJECT_OID)
                    }, {
                        $set: {
                            STATUS: 'CLASSIFIED',
                            CLASSIFICATION_TIME: timeInSeconds
                        },
                        $unset: {
                            SKIPPED_BY_USERS: 1
                        }
                    }, function (err, res) {
                        if (err)
                            callback(err);

                        else {
                            console.log(res.result.n, 'records updated while saving the classification.');
                            callback(null);
                        }
                    });
                },
                function (callback) {
                    if (userType === config.get('USER_TYPE').FREELANCER.NAME && request.auth.credentials.user.PROJECT_STATUS === 'ACTIVE') {
                        var updateData = {
                            [`PROJECTS.${request.payload.PROJECT_ID}.TOTAL_IMAGES_CLASSIFIED`]: 1,
                            [`PROJECTS.${request.payload.PROJECT_ID}.TOTAL_TIME`]: timeInSeconds
                        }

                        db.collection(config.get('USER_COLLECTION')).updateOne({
                            _id: new mongo.ObjectID(request.auth.credentials.user._id.toString())
                        }, {
                            $inc: updateData
                        }, function (err, res) {
                            if (err)
                                callback(err);

                            else {
                                console.log(res.result.n, 'records updated while saving the classification.');
                                callback(null);
                            }
                        });
                    }

                    else
                        callback(null);
                }
            ], function (err, results) {
                if (err)
                    service.handleError(reject, err);

                else
                    resolve(newImageData);
                });
        });

        return promise;
    }

    this.updateClassifiedImageHandler = function (request, h) {
        var promise = new Promise((resolve, reject) => {

            request.payload = JSON.parse(request.payload);

            if (userType === config.get('USER_TYPE').FREELANCER.NAME && request.auth.credentials.user.PROJECT_STATUS === 'TRAINING') {
                service.handleError(reject, 'Please complete the training first!');         // saveFreelancerTrainingImage function used to save freelancer training images
                return;
            }

            var timeInSeconds = (request.payload.hours * 3600) + (request.payload.minutes * 60) + request.payload.seconds;

            var data = {
                USER_OID: new mongo.ObjectID(request.auth.credentials.user._id.toString()),
                LABEL_DETAILS: new Array(),
                CLASSIFICATION_START_DATE: new Date(request.payload.startTime).getTime(),
                CLASSIFICATION_END_DATE: new Date(request.payload.endTime).getTime(),
                CLASSIFICATION_TOTAL_TIME: timeInSeconds,
                IMAGE_WIDTH: request.payload.IMAGE_WIDTH,
                IMAGE_HEIGHT: request.payload.IMAGE_HEIGHT
            }

            annotations = [];

            data['LABEL_DETAILS'].forEach(label => {
                var annotation = {};
                var labelName = {};
                for(key in label) {
                    if(key == "LABEL_NAME"){
                        labelName.LABEL = label[key];
                    }
                    else if(key !== "EDGES_POLY"){
                        label[key].forEach(rectangle => {
                            annotation = {...rectangle, ...labelName};
                            annotations.push(annotation);
                            annotation = {};
                        })
                    }
                    else if(key == "EDGES_POLY"){
                        label[key].forEach(coordinates => {
                            for(key in coordinates) {
                                if(key == "COORDINATES"){
                                    var index = 0;
                                    coordinates[key].forEach(point => {
                                        annotation[`X_${index}`] = point.X;
                                        annotation[`Y_${index}`] = point.Y;
                                        annotation[`X_${index}_PERCENT`] = point.X_PERCENT;
                                        annotation[`Y_${index}_PERCENT`] = point.Y_PERCENT;
                                        index++;
                                    })
                                    annotations.push(annotation);
                                }
                            }
                        })
                    }
                }
            })

            var userType = request.auth.credentials.user.USER_TYPE;

            if((userType == config.get('USER_TYPE').SELF.NAME) || (userType == config.get('USER_TYPE').STUDENT_SELF.NAME)) {
                formatAnnotationData(data, request.payload.data, request.payload.projectType, request.auth.credentials.user.SUBSCRIPTION_FLAG.SHAPES);
            } else {
                formatAnnotationData(data, request.payload.data, request.payload.projectType, request.auth.credentials.admin.SUBSCRIPTION_FLAG.SHAPES);
            }

            _async.parallel([
                function (callback) {
                    db.collection(config.get('WORKING_IMAGES_COLLECTION')).removeOne({
                        OBJECT_OID: new mongo.ObjectID(request.payload.OBJECT_OID)
                    }, function (err, res) {
                        if (err)
                            callback(err);

                        else {
                            console.log(res.result.n, 'objects removed from working collection');

                            callback(null);
                        }
                    });
                },
                function (callback) {
                    db.collection(config.get('CLASSIFIED_OBJECT_COLLECTION')).updateOne({
                        OBJECT_OID: new mongo.ObjectID(request.payload.OBJECT_OID)
                    },
                    {
                        $set: data
                    },
                    function (err, res) {
                        if (err)
                            callback(err);

                        else
                            callback(null, {success: true})
                    });
                }
            ], function (err, results) {
                if (err)
                    service.handleError(reject, err);

                else
                    resolve(results[1]);
            });
        });

        return promise;
    }

    function formatAnnotationData(data, annotationData, projectType, shapesSubscriptionFlag) {
        console.log("PROJECT TYPE", projectType)
        var widthFactor = data.IMAGE_WIDTH / 100;
        var heightFactor = data.IMAGE_HEIGHT / 100;

        if (projectType == config.get('PROJECT_TYPE').IMAGE_SEGMENTATION) {
            for (var key in annotationData) {
                var obj = {
                    LABEL_NAME: key
                }

                if (shapesSubscriptionFlag.RECTANGLE && annotationData[key].rect.length > 0) {
                    obj.EDGES_RECT = new Array();

                    annotationData[key].rect.forEach(function (item) {
                        if (item.height < 0) {
                            item.startY = item.startY + item.height;
                            item.height *= -1;
                        }

                        if (item.width < 0) {
                            item.startX = item.startX + item.width;
                            item.width *= -1;
                        }

                        obj.EDGES_RECT.push({
                            START_X: item.startX * widthFactor,
                            START_Y: item.startY * heightFactor,
                            HEIGHT: item.height * heightFactor,
                            WIDTH: item.width * widthFactor,
                            START_X_PERCENT: item.startX,
                            START_Y_PERCENT: item.startY,
                            HEIGHT_PERCENT: item.height,
                            WIDTH_PERCENT: item.width
                        });
                    });
                }

                if (shapesSubscriptionFlag.POLYGON && annotationData[key].poly.length > 0) {
                    obj.EDGES_POLY = new Array();

                    annotationData[key].poly.forEach((polygon) => {
                        var tempPolygon = {
                            COORDINATES: new Array()
                        }

                        polygon.forEach((element) => {
                            tempPolygon.COORDINATES.push({
                                X: element.x * widthFactor,
                                Y: element.y * heightFactor,
                                X_PERCENT: element.x,
                                Y_PERCENT: element.y
                            });
                        });

                        obj.EDGES_POLY.push(tempPolygon);
                    });
                }

                if (shapesSubscriptionFlag.CIRCLE && annotationData[key].circle.length > 0) {
                    obj.EDGES_CIRCLE = new Array();

                    annotationData[key].circle.forEach(function (item) {
                        obj.EDGES_CIRCLE.push({
                            CENTER_X: item.centreX * widthFactor,
                            CENTRE_Y: item.centreY * heightFactor,
                            RADIUS: item.radius * widthFactor,
                            CENTER_X_PERCENT: item.centreX,
                            CENTRE_Y_PERCENT: item.centreY,
                            RADIUS_PERCENT: item.radius
                        });
                    });
                }

                if (shapesSubscriptionFlag.POINT && annotationData[key].point.length > 0) {
                    obj.EDGES_POINT = new Array();

                    annotationData[key].circle.forEach(function (item) {
                        obj.EDGES_POINT.push({
                            CENTER_X: item.centreX * widthFactor,
                            CENTRE_Y: item.centreY * heightFactor,
                            CENTER_X_PERCENT: item.centreX,
                            CENTRE_Y_PERCENT: item.centreY
                        });
                    });
                }

                if (shapesSubscriptionFlag.CUBOID && annotationData[key].cuboid.length > 0) {
                    obj.EDGES_CUBOID = new Array();

                    console.log(annotationData);

                    annotationData[key].cuboid.forEach(function (item) {
                        if (item.rect1.height < 0) {
                            item.rect1.y = item.rect1.y + item.rect1.height;
                            item.rect1.height *= -1;
                        }

                        if (item.rect2.height < 0) {
                            item.rect2.y = item.rect2.y + item.rect2.height;
                            item.rect2.height *= -1;
                        }

                        if (item.rect1.width < 0) {
                            item.rect2.x = item.rect2.x + item.rect2.width;
                            item.rect2.width *= -1;
                        }

                        obj.EDGES_CUBOID.push({
                            RECT1: {
                                START_X: item.rect1.x * widthFactor,
                                START_Y: item.rect1.y * heightFactor,
                                HEIGHT: item.rect1.height * heightFactor,
                                WIDTH: item.rect1.width * widthFactor,
                                START_X_PERCENT: item.rect1.x,
                                START_Y_PERCENT: item.rect1.y,
                                HEIGHT_PERCENT: item.rect1.height,
                                WIDTH_PERCENT: item.rect1.width
                            },
                            RECT2: {
                                START_X: item.rect2.x * widthFactor,
                                START_Y: item.rect2.y * heightFactor,
                                HEIGHT: item.rect2.height * heightFactor,
                                WIDTH: item.rect2.width * widthFactor,
                                START_X_PERCENT: item.rect2.x,
                                START_Y_PERCENT: item.rect2.y,
                                HEIGHT_PERCENT: item.rect2.height,
                                WIDTH_PERCENT: item.rect2.width
                            }
                        });
                    });
                }

                data.LABEL_DETAILS.push(obj);
            }
        } else if (projectType == config.get('PROJECT_TYPE').IMAGE_TAGGING) {
            data.LABEL_DETAILS.push(annotationData);
        }

    }

    this.skipImageHandler = function (request, h) {
        var promise = new Promise ((resolve, reject) => {
            let userType = request.auth.credentials.user.USER_TYPE

            if (userType ==  config.get('USER_TYPE').SELF.NAME || userType ==  config.get('USER_TYPE').STUDENT_SELF.NAME || userType ==  config.get('USER_TYPE').TEAM.NAME) {

                let id = request.auth.credentials.admin ? request.auth.credentials.admin._id.toString() : request.auth.credentials.user._id.toString();

                console.log(request.payload);

                // Fetch new Image
                this.fetchNewImage(request.payload.PROJECT_ID, id, request.auth.credentials.user._id)
                    .then((data) => {

                        if (data.value) {  // New Image Found
                            _async.parallel([
                                function (callback) {
                                    // If user has not drawn any shape but the image has saved in working image collection
                                    db.collection(config.get('WORKING_IMAGES_COLLECTION')).deleteOne({
                                        OBJECT_OID: new mongo.ObjectId(request.payload.OBJECT_OID)
                                    }, function (err, result) {
                                        if(err)
                                            callback(err);

                                        else{
                                            console.log(`${result.deletedCount} image/s deleted from Working images collection`);
                                            callback(null)
                                        }
                                    });
                                }, function (callback) {
                                    // If user hasn't drawn any shape, Set image status to new
                                    db.collection(config.get('IMAGES_COLLECTION')).updateOne({
                                        _id: new mongo.ObjectId(request.payload.OBJECT_OID)
                                    }, {
                                        $set : {
                                            STATUS: 'NEW'
                                        },
                                        $push: {
                                            SKIPPED_BY_USERS: new mongo.ObjectId(request.auth.credentials.user._id)
                                        }
                                    }, function (err, result) {
                                        if(err)
                                            callback(err);

                                        else{
                                            console.log(`${result.modifiedCount} image/s modified in Images collection.`);
                                            callback(null)
                                        }
                                    });
                                }
                            ], function(err, result) {
                                if(err)
                                    service.handleError(reject, err);

                                else
                                    resolve({redirect: 'classify/' + data.value._id.toString()});
                            });
                        } else { // No image found
                            return promise = new Promise((resolve, reject) => {
                                db.collection(config.get('IMAGES_COLLECTION')).updateOne({
                                    _id: new mongo.ObjectId(request.payload.OBJECT_OID)
                                }, {
                                    $set : {
                                        STATUS: 'NEW'
                                    }
                                }, function(err, data) {
                                    if (err)
                                        reject(err);

                                    else
                                        service.handleError(reject, 'No more images were found');
                                        resolve(data);
                                });
                            })
                            service.handleError(reject, 'No more images were found');
                        }
                    }).catch( err => service.handleError(reject, err));
            }

            else
                service.handleError(reject, 'This functionality is not available for ' + userType + ' users.')
        });

        return promise;
    }

    this.fetchNewImage = function (projectId, id, userId) {
        return promise = new Promise((resolve, reject) => {
            db.collection(config.get('IMAGES_COLLECTION')).findAndModify({
                USER_OID: new mongo.ObjectId(id),
                STATUS: 'NEW',
                PROJECT_ID : projectId,
                SKIPPED_BY_USERS: {
                    $nin: [new mongo.ObjectId(userId)]
                }
            },
            [],
            {
                $set: {
                    STATUS: 'ASSIGNED'
                }
            }, {
                upsert: false
            }, function(err, data) {
                if (err)
                    reject(err);

                else
                    resolve(data);
            });
        });
    }

    /*********************************** For freelancer training ******************************/

    this.nextFreelancerTrainingImageHandler = function (request, user) {
        var promise = new Promise((resolve, reject) => {
            _async.waterfall([
                function(callback) {
                    db.collection(config.get('FREELANCER_VALIDATION_COLLECTION')).findOne({
                        OBJECT_OID: new mongo.ObjectID(request.params.id),
                        TRAINING: 'COMPLETED'
                    }, function (err, item) {
                        if (err)
                            callback(err);

                        else if (item)
                            callback('This image is already classified.');

                        else
                            callback(null)
                    });
                },
                function(callback) {
                    db.collection(config.get('IMAGES_COLLECTION')).findOne({
                        _id: new mongo.ObjectID(request.params.id)
                    }, function (err, item) {
                        if (err)
                            callback(err);

                        else if(!item)
                            callback('This image was not found');

                        else if (item.OBJECT_STORAGE_NAME == 'S3') {
                            var storageDetails = user.PROJECTS[request.query.projectId].STORAGE_DETAILS['S3'];

                            AWS.config.update({
                                accessKeyId: storageDetails.ACCESS_KEY,
                                secretAccessKey: storageDetails.SECRET_KEY,
                                region: storageDetails.REGION_NAME
                            });

                            var s3 = new AWS.S3();

                            s3Handlers.getFile(request, s3, storageDetails.BUCKET_NAME, item.ORIGINAL_OBJECT_NAME).then(function (data) {
                                callback(null, {
                                    data: data.content,
                                    id: item._id,
                                    IMAGE_WIDTH: data.dimension.width,
                                    IMAGE_HEIGHT: data.dimension.height
                                });
                            }, function (err) {
                                callback(err);
                            });
                        }

                        else if (item.OBJECT_STORAGE_NAME == "GOOGLE_DRIVE") {

                            gdriveHandlers.getFile(item.ORIGINAL_OBJECT_NAME, item.OBJECT_NAME, request, db).then((data) => {
                                callback(null, {
                                    data: data,
                                    id: item._id,
                                    IMAGE_WIDTH: item.IMAGE_WIDTH,
                                    IMAGE_HEIGHT: item.IMAGE_HEIGHT
                                });
                            }, function (err) {
                                callback(err);
                            });
                        }
                    });
                }
            ], function (err, image) {
                if (err)
                    reject(err)

                else
                    resolve(image)
            });
        });

        return promise;
    }

    this.saveFreelancerTrainingImage = function (request, h) {      // Update data in Freelancer_validation collection
        var promise = new Promise((resolve, reject) => {
            request.payload = JSON.parse(request.payload);

            _async.parallel([
                function (callback) {
                    db.collection(config.get('WORKING_IMAGES_COLLECTION')).removeOne({
                        OBJECT_OID: new mongo.ObjectID(request.payload.OBJECT_OID)
                    }, function (err, res) {
                        if (err)
                            callback(err);

                        else {
                            console.log(res.result.n, 'objects removed from working collection');

                            callback(null);
                        }
                    });
                },
                function (callback) {
                    db.collection(config.get('FREELANCER_VALIDATION_COLLECTION')).updateOne({
                        OBJECT_OID: new mongo.ObjectID(request.payload.OBJECT_OID)
                    },{
                        $set: {
                            TRAINING: 'COMPLETED',
                            FREELANCER_OID: new mongo.ObjectId(request.auth.credentials.user._id.toString())
                        }
                    }, function (err, res) {
                        if (err)
                            callback(err);

                        else {
                            service.checkClassifiedImageCount(request).then(() => {
                                service.getImageForClassifyScreen(request, request.auth.credentials.user, request.auth.credentials.admin, request.payload.PROJECT_ID, function (err, data) {
                                    if(err)
                                        callback(err);

                                    else {
                                        callback(null, data);
                                    }
                                });
                            }).catch(err => callback(err));
                        }
                    });
                }
            ], function (err, results) {
                if (err)
                    service.handleError(reject, err);

                else
                    resolve(results[1]);
            });
        });

        return promise;
    }

    this.freelancerGetClassifiedData = function (request, h) {    // For freelancer training
        var promise = new Promise((resolve, reject) => {
            db.collection(config.get('FREELANCER_VALIDATION_COLLECTION')).findOne({
                OBJECT_OID: new mongo.ObjectID(request.params.objectId)
            }, function(err, img) {
                if (err)
                    service.handleError(reject, err);

                else if(img && img.LABEL_DETAILS)
                    resolve({ data: img.LABEL_DETAILS });

                else
                    callback('No image found!');
            });
        });

        return promise;
    }

    return this;
}
