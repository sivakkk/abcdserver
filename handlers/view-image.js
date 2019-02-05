module.exports = function(service) {
    var config = require('../config/config')();
    var _async = require('async');
    var AWS = require('aws-sdk');
    var mongo = require('mongodb');
    var gdriveHandlers = require('../handlers/storages/gdrive.js')(service);
    var s3Handlers = require('../handlers/storages/s3.js')(service);
    var azureHandlers = require('../handlers/storages/azure.js')(service);
    var db = config.getDB();

    this.getImages = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            let query = request.query,
                sortQuery = {
                    _id: -1
                },
                searchQuery = {
                    $regex: query.searchTerm,
                    $options: 'i'
                },
                status = query.status.split(','),
                statusQuery = status[0] === "" ? {
                    $exists: true
                } : {
                    $in: status
                },
                imageName = 'OBJECT_NAME',
                userId = (request.auth.credentials.user.USER_TYPE == config.get('USER_TYPE').TEAM.NAME) ? request.auth.credentials.admin._id : request.auth.credentials.user._id;
            console.log(query.bucketName);

            if (query.bucketName != "" && query.bucketName != undefined) {
                imageName = 'ORIGINAL_OBJECT_NAME'
            }

            if (request.query.sortingMethod === ('Name A to Z')) {
                sortQuery = {
                    [imageName]: 1
                };
            } else if (request.query.sortingMethod === ('Name Z to A')) {
                sortQuery = {
                    [imageName]: -1
                };
            } else if (request.query.sortingMethod === ('Latest First')) {
                sortQuery = {
                    OBJECT_DETAILS_LOAD_DATE: -1
                };
            } else if (request.query.sortingMethod === ('Oldest First')) {
                sortQuery = {
                    OBJECT_DETAILS_LOAD_DATE: 1
                };
            }

            _async.waterfall([
                function(callback) {
                    db.collection(config.get('USER_COLLECTION')).findOne({
                        _id: new mongo.ObjectID(request.auth.credentials.user._id.toString())
                    }, function(err, userData) {
                        if (err)
                            callback(err);

                        else
                            callback(null, userData);
                    })
                },
                function(userData, callback) {
                    db.collection(config.get('IMAGES_COLLECTION')).find({
                            USER_OID: new mongo.ObjectId(userId),
                            PROJECT_ID: request.query.projectId,
                            STATUS: statusQuery,
                            [imageName]: searchQuery
                        }, {
                            PROJECT_ID: 0,
                            USER_OID: 0
                        }).sort(sortQuery).skip(parseInt(query.skip)).limit(parseInt(query.limit))
                        .toArray(function(err, images) {
                            if (err)
                                callback(err);

                            else
                                callback(null, userData, images);
                        });
                },
                function(userData, images, callback) {
                    if (images.length !== 0) {
                        var s3 = new AWS.S3();

                        _async.eachSeries(images, function(image, eachSeriesCallback) {
                            if (image.OBJECT_STORAGE_NAME === 'GOOGLE_DRIVE') {
                                gdriveHandlers.getFileGoogleDrive(image.ORIGINAL_OBJECT_NAME, image.OBJECT_NAME, request, db)
                                    .then(data => {
                                        image.data = data;
                                        eachSeriesCallback(null);
                                    })
                                    .catch(err => eachSeriesCallback(err));
                            } else if (image.OBJECT_STORAGE_NAME === 'S3') {
                                s3Handlers.getFileS3(request, s3, query.bucketName, image.ORIGINAL_OBJECT_NAME, 'image_only')
                                    .then(data => {
                                        image.data = data.content;
                                        eachSeriesCallback(null);
                                    })
                                    .catch(err => eachSeriesCallback(err));
                            } else if (image.OBJECT_STORAGE_NAME === 'AZURE_STORAGE') {
                                azureHandlers.getFileAzure(userData, image.ORIGINAL_OBJECT_NAME, request.query.projectId, (err, data) => {
                                    if (err)
                                        eachSeriesCallback(err);

                                    else {
                                        image.data = data.dataURI;
                                        eachSeriesCallback(null);
                                    }
                                });
                            }
                        }, function(err) {
                            if (err)
                                callback(err);

                            else
                                callback(null, images);
                        })
                    } else
                        callback(null, images);
                }
            ], function(err, images) {
                if (err)
                    service.handleError(reject, err);

                else
                    resolve({
                        images
                    })
            });

        });
        return promise;
    }


    this.unlockImage = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            _async.parallel([
                function(callback) {
                    db.collection(config.get('WORKING_IMAGES_COLLECTION')).deleteOne({
                        OBJECT_OID: new mongo.ObjectId(request.payload._id)
                    }, function(err, result) {
                        if (err)
                            callback(err);

                        else {
                            console.log(`${result.deletedCount} image/s deleted from Working images collection`);
                            callback(null)
                        }
                    });
                },
                function(callback) {
                    db.collection(config.get('CLASSIFIED_OBJECT_COLLECTION')).deleteOne({
                        OBJECT_OID: new mongo.ObjectId(request.payload._id)
                    }, function(err, result) {
                        if (err)
                            callback(err);

                        else {
                            console.log(`${result.deletedCount} image/s deleted from Classified images collection`);
                            callback(null)
                        }
                    });
                },
                function(callback) {
                    db.collection(config.get('IMAGES_COLLECTION')).updateOne({
                        _id: new mongo.ObjectId(request.payload._id)
                    }, {
                        $set: {
                            STATUS: 'NEW'
                        }
                    }, function(err, result) {
                        if (err)
                            callback(err);

                        else {
                            console.log(`${result.modifiedCount} image/s modified in Images collection.`);
                            callback(null)
                        }
                    });
                }
            ], function(err) {
                if (err)
                    service.handleError(reject, err);

                else
                    resolve({
                        success: true
                    });
            });
        });
        return promise;
    }


    this.getImageDetails = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            let query = request.query,
                collection;

            if (query.status === 'CLASSIFIED') {
                collection = 'CLASSIFIED_OBJECT_COLLECTION';
            } else if (query.status === 'ASSIGNED') {
                collection = 'WORKING_IMAGES_COLLECTION';
            }

            db.collection(config.get(collection)).findOne({
                OBJECT_OID: new mongo.ObjectId(query.id),
                PROJECT_ID: request.query.projectId,
            }, {
                LABEL_DETAILS: 1
            }, function(err, image) {
                if (err)
                    service.handleError(reject, err);

                else if (!image)
                    service.handleError(reject, err, 'No details found for this image!');

                else
                    resolve(image);
            });
        });
        return promise;
    }


    return this;
}
