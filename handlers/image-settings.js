module.exports = function(service) {
    var config = require('../config/config')();
    var _async = require('async');
    var mongo = require('mongodb');
    var uuid = require('uuid/v1');
    var db = config.getDB();

    this.imageSettingHandlers = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            let _id = request.auth.credentials.user._id;

            if (request.auth.credentials.user.USER_TYPE == config.get('USER_TYPE').TEAM.NAME) {
                _id = request.auth.credentials.admin._id;
            }

            db.collection(config.get('USER_COLLECTION')).findOne({
                _id: mongo.ObjectId(_id)
            }, function(err, res) {
                if (err) {
                    service.handleError(reject, err);
                } else {
                    if (!res.PROJECTS[request.query.projectId]) {
                        service.handleError(reject, 'This project doesn\'t exist.');
                        return;
                    }

                    var activeStorage = res.PROJECTS[request.query.projectId].ACTIVE_STORAGE;
                    var result = {
                        totalTimeSpent: 0,
                        totalImages: 0,
                        classifiedImages: 0,
                        activeStorage: activeStorage,
                        storage: {
                            [activeStorage]: config.get('DATA_MODEL').STORAGE_DATA[activeStorage]
                        }
                    }

                    if (res.PROJECTS[request.query.projectId].STORAGE_DETAILS) {
                        var objectData = res.PROJECTS[request.query.projectId].STORAGE_DETAILS;

                        Object.keys(objectData[activeStorage]).forEach(function(key) {
                            result.storage[activeStorage][key] = objectData[activeStorage][key];
                        });

                        _async.parallel([
                            function(callback) {
                                db.collection(config.get('IMAGES_COLLECTION')).count({
                                    USER_OID: new mongo.ObjectID(_id.toString()),
                                    PROJECT_ID: request.query.projectId
                                }, function(err, count) {
                                    if (err)
                                        callback(err)

                                    else {
                                        result.totalImages = count;

                                        callback(null);
                                    }
                                });
                            },
                            function(callback) {
                                db.collection(config.get('IMAGES_COLLECTION')).count({
                                    USER_OID: new mongo.ObjectID(_id.toString()),
                                    PROJECT_ID: request.query.projectId,
                                    STATUS: 'CLASSIFIED'
                                }, function(err, count) {
                                    if (err)
                                        callback(err)

                                    else {
                                        result.classifiedImages = count;

                                        callback(null);
                                    }
                                });
                            },
                            function(callback) {
                                db.collection(config.get('IMAGES_COLLECTION')).aggregate([{
                                    $match: {
                                        USER_OID: new mongo.ObjectID(_id.toString()),
                                        PROJECT_ID: request.query.projectId,
                                        STATUS: 'CLASSIFIED'
                                    }
                                }, {
                                    $group: {
                                        _id: '$_id',
                                        time: {
                                            $sum: '$CLASSIFICATION_TIME'
                                        }
                                    }
                                }], function(err, doc) {
                                    if (err)
                                        callback(err)

                                    else {
                                        if (doc.time)
                                            result.totalTimeSpent = doc.time;

                                        callback(null);
                                    }
                                });
                            }
                        ], function(err) {
                            if (err)
                                service.handleError(reject, err, 'Error while getting image settings.');

                            else
                                resolve(result);
                        });
                    } else
                        resolve(result);
                }
            })
        });

        return promise;
    }

    this.regenerateExportTokenHandler = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            if (request.auth.credentials.user.USER_TYPE == config.get('USER_TYPE').TEAM.NAME) {
                service.handleError(reject, 'You are not allowed to use this functionality');
                return;
            }

            db.collection(config.get('USER_COLLECTION')).findOne({
                _id: new mongo.ObjectID(request.auth.credentials.user._id)
            }, function(err, user) {
                if (err) {
                    service.handleError(reject, err);
                } else if (user) {
                    var projectId = request.payload.projectId;

                    if (!projectId)
                        projectId = 'DEFAULT';

                    var query = {
                        PROJECTS: user.PROJECTS
                    }

                    var token = uuid();

                    user.PROJECTS[projectId].EXPORT_TOKEN = token;

                    db.collection(config.get('USER_COLLECTION')).findOneAndUpdate({
                        _id: new mongo.ObjectID(request.auth.credentials.user._id)
                    }, {
                        $set: query
                    }, function(err, res) {
                        if (err)
                            service.handleError(reject, err, 'Error while regenerating the export token.');

                        else {
                            resolve({
                                EXPORT_TOKEN: token
                            });
                        }
                    });
                }
            })

        });
        return promise;
    }

    this.updateStorage = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            if (!request.auth.credentials.user.SUBSCRIPTION_FLAG.STORAGE[request.payload.activeStorage])
                service.handleError(reject, 'You don\'t have access to this storage');

            else if (!config.get('UI_SCHEMA').STORAGE_TYPES[request.payload.activeStorage] || !config.get('UI_SCHEMA').STORAGE_TYPES[request.payload.activeStorage].IS_ENABLED)
                service.handleError(reject, 'This storage is not available.');

            else if (!request.payload.projectId || request.payload.projectId == '')
                service.handleError(reject, 'Project Id is missing.');

            else {
                db.collection(config.get('USER_COLLECTION')).findOne({
                    _id: new mongo.ObjectID(request.auth.credentials.user._id)
                }, {
                    PASSWORD: 0
                }, function(err, user) {
                    if (err) {
                        service.handleError(reject, err);
                    } else {
                        user.PROJECTS[request.payload.projectId].ACTIVE_STORAGE = request.payload.activeStorage;
                        user.PROJECTS[request.payload.projectId].STORAGE_DETAILS[request.payload.activeStorage] = request.payload.storage;

                        db.collection(config.get('USER_COLLECTION')).findOneAndUpdate({
                            _id: new mongo.ObjectID(request.auth.credentials.user._id)
                        }, {
                            $set: {
                                PROJECTS: user.PROJECTS
                            }
                        }, function(err, res) {
                            if (err)
                                service.handleError(reject, err, 'Error while updating the storage.');

                            else
                                resolve(res);
                        });
                    }
                });
            }
        });

        return promise;
    }

    this.exportHandler = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            var fields = config.get('EXPORT_FIELDS');
            var result = new Array();
            var csv;

            console.log(request.auth.credentials);
            if (request.auth.credentials.user.USER_TYPE == config.get('USER_TYPE').TEAM.NAME) {
                service.handleError(reject, 'You are not allowed to use this functionality');
                return;
            }

            if (request.auth.credentials.user.USER_TYPE !== config.get('USER_TYPE').SELF.NAME && request.auth.credentials.user.USER_TYPE !== config.get('USER_TYPE').STUDENT_SELF.NAME) {
                export_query = {
                    ADMIN_ID: new mongo.ObjectID(request.auth.credentials.user._id)
                }
            } else {
                export_query = {
                    _id: new mongo.ObjectID(request.auth.credentials.user._id)
                }
            }

            // if(!request.auth.credentials.user['SUBSCRIPTION_FLAG']['FEATURES']['API_EXPORT']){
            //     service.handleError(reject, 'User not allowed', 'You are not allowed');
            // }

            db.collection(config.get('USER_COLLECTION')).find(
                export_query
            ).toArray(function(err, docs) {
                if (err)
                    service.handleError(reject, err, 'Errow while fetching records.');
                // else if(!docs[0]['SUBSCRIPTION_FLAG']['FEATURES']['API_EXPORT']){
                //     service.handleError(reject, 'Upgrade to PRO to enable API exports');
                // }

                else {
                    console.log(request.auth.credentials.user._id);
                    console.log('docs.length', docs.length);

                    var labels = {};
                    var temp;
                    let imageName = '$IMAGE_DETAILS.OBJECT_NAME';
                    if (request.payload.activeStorage === "S3") {
                        imageName = '$IMAGE_DETAILS.ORIGINAL_OBJECT_NAME';
                    }

                    _async.waterfall([
                        function(waterfallCallback) {
                            db.collection(config.get('LABEL_COLLECTION')).find({
                                USER_OID: new mongo.ObjectID(request.auth.credentials.user._id),
                                PROJECT_ID: request.payload.projectId
                            }).toArray(function(err, items) {
                                if (err)
                                    waterfallCallback(err);

                                else {
                                    items.forEach(function(label) {
                                        labels[label.LABEL_NAME] = label.LABEL_CATEGORY
                                    });

                                    temp = items;

                                    waterfallCallback(null);

                                    console.log(labels);
                                }
                            });
                        },
                        function(waterfallCallback) {
                            _async.each(docs, function(doc, callback) {
                                db.collection(config.get('CLASSIFIED_OBJECT_COLLECTION')).aggregate([{
                                    $match: {
                                        USER_OID: new mongo.ObjectID(doc._id.toString()),
                                        PROJECT_ID: request.payload.projectId
                                    }
                                }, {
                                    $unwind: '$LABEL_DETAILS'
                                }, {
                                    $unwind: '$LABEL_DETAILS.EDGES_RECT'
                                }, {
                                    $lookup: {
                                        from: config.get('IMAGES_COLLECTION'),
                                        localField: 'OBJECT_OID',
                                        foreignField: '_id',
                                        as: 'IMAGE_DETAILS'
                                    }
                                }, {
                                    $lookup: {
                                        from: config.get('USER_COLLECTION'),
                                        localField: 'USER_OID',
                                        foreignField: '_id',
                                        as: 'CLASSIFIED_BY'
                                    }
                                }, {
                                    $unwind: '$IMAGE_DETAILS'
                                }, {
                                    $unwind: '$CLASSIFIED_BY'
                                }, {
                                    $project: {
                                        _id: '$_id',
                                        IMAGE_NAME: imageName,
                                        OBJECT_STORAGE: '$IMAGE_DETAILS.OBJECT_STORAGE_NAME',
                                        CLASSIFIED_BY: '$CLASSIFIED_BY.NAME',
                                        LABEL_NAME: '$LABEL_DETAILS.LABEL_NAME',
                                        LABEL_CATEGORY: {
                                            $let: {
                                                vars: {
                                                    labels: labels,
                                                    temp: temp,
                                                    category: labels['$LABEL_DETAILS.LABEL_NAME']
                                                },
                                                in: {
                                                    $cond: {
                                                        if: ['$LABEL_DETAILS.LABEL_NAME', '$$temp.LABEL_NAME'],
                                                        then: '$$temp.LABEL_CATEGORY',
                                                        else: ''
                                                    }
                                                }
                                            }
                                        },
                                        EDGES: '$LABEL_DETAILS.EDGES_RECT'
                                    }
                                }], function(err, items) {
                                    if (err)
                                        callback(err);

                                    else {
                                        console.log(items.length);
                                        result = items;

                                        console.log(items[0]);

                                        callback(null);
                                    }
                                });
                            }, function(err) {
                                if (err)
                                    waterfallCallback(err);

                                else {
                                    var Json2csvParser = require('json2csv').Parser;

                                    var json2csvParser = new Json2csvParser({
                                        fields: fields,
                                        unWind: ['EDGES']
                                    });

                                    csv = json2csvParser.parse(result);

                                    waterfallCallback(null);
                                }
                            });
                        }
                    ], function(err, results) {
                        if (err)
                            service.handleError(reject, err, 'Errow while fetching records.');

                        else
                            resolve(csv);
                    });
                }
            });
        });

        return promise;
    }

    this.apiExportHandler = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            if (!request.query)
                service.handleError(reject, 'Request payload is missing');

            else if (!request.query.email)
                service.handleError(reject, 'Email Id is missing');

            else if (!request.query.token)
                service.handleError(reject, 'Export Token is missing');

            else if (!request.query.projectId)
                service.handleError(reject, 'Project Id is missing');

            else {
                var query = {
                    EMAIL_ID: request.query.email.toLowerCase(),
                }

                var project = `PROJECTS.${request.query.projectId}.EXPORT_TOKEN`
                query[project] = request.query.token;
                // query.PROJECTS[request.query.projectId].EXPORT_TOKEN = request.query.token    // This throws error, Implemented new query above this line

                db.collection(config.get('USER_COLLECTION')).findOne(query, function(err, item) {
                    if (err)
                        service.handleError(reject, err, 'Error while fetching records.');

                    else if (!item)
                        service.handleError(reject, 'Authentication Token doesn\'t match');

                    else if (item.USER_TYPE == config.get('USER_TYPE').STUDENT_SELF.NAME || item.USER_TYPE == config.get('USER_TYPE').STUDENT_ADMIN.NAME)
                        service.handleError(reject, 'You are not allowed to use this functionality');

                    else {
                        if (item.USER_TYPE != config.get('USER_TYPE').SELF.NAME && item.USER_TYPE != config.get('USER_TYPE').STUDENT_SELF.NAME) {
                            api_export_query = {
                                ADMIN_ID: new mongo.ObjectID(item._id)
                            }
                        } else {
                            api_export_query = {
                                _id: new mongo.ObjectID(item._id)
                            }
                        }

                        db.collection(config.get('USER_COLLECTION')).find(
                            api_export_query
                        ).toArray(function(err, docs) {
                            if (err)
                                service.handleError(reject, err, 'Error while fetching records.');

                            else {
                                console.log(item._id);
                                console.log('users found', docs.length);

                                let imageName = '$IMAGE_DETAILS.OBJECT_NAME';
                                if (request.query.activeStorage === "S3") {
                                    imageName = '$IMAGE_DETAILS.ORIGINAL_OBJECT_NAME';
                                }
                                var images = new Array();
                                var temp;

                                _async.each(docs, function(doc, callback) {
                                    db.collection(config.get('CLASSIFIED_OBJECT_COLLECTION')).aggregate([{
                                        $match: {
                                            USER_OID: new mongo.ObjectID(doc._id.toString())
                                        }
                                    }, {
                                        $lookup: {
                                            from: config.get('IMAGES_COLLECTION'),
                                            localField: 'OBJECT_OID',
                                            foreignField: '_id',
                                            as: 'IMAGE_DETAILS'
                                        }
                                    }, {
                                        $match: {
                                            PROJECT_ID: request.query.projectId
                                        }
                                    }, {
                                        $lookup: {
                                            from: config.get('USER_COLLECTION'),
                                            localField: 'USER_OID',
                                            foreignField: '_id',
                                            as: 'CLASSIFIED_BY'
                                        }
                                    }, {
                                        $unwind: '$IMAGE_DETAILS'
                                    }, {
                                        $unwind: '$CLASSIFIED_BY'
                                    }, {
                                        $project: {
                                            _id: 0,
                                            IMAGE_NAME: imageName,
                                            OBJECT_STORAGE: '$IMAGE_DETAILS.OBJECT_STORAGE_NAME',
                                            CLASSIFIED_BY: '$CLASSIFIED_BY.NAME',
                                            LABEL_DETAILS: 1,
                                            IMAGE_WIDTH: 1,
                                            IMAGE_HEIGHT: 1
                                        }
                                    }], function(err, items) {
                                        if (err)
                                            callback(err);

                                        else {
                                            images = images.concat(items);

                                            callback(null);
                                        }
                                    });
                                }, function(err) {
                                    if (err)
                                        service.handleError(reject, err, 'Error while fetching records.');

                                    else
                                        resolve(images);
                                });
                            }
                        });
                    }
                });
            }
        });

        return promise;
    }

    this.disconnectGoogleDrive = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            _async.waterfall([
                function(callback) {
                    if (request.payload.deleteFiles) {
                        console.log('Deleting the OCLAVI folder on google drive for ' + request.auth.credentials.user.EMAIL_ID);

                        var {
                            google
                        } = require('googleapis');
                        var OAuth2 = google.auth.OAuth2;
                        var oauth2Client = new OAuth2(
                            config.get('GOOGLE_DRIVE').CLIENT_ID,
                            config.get('GOOGLE_DRIVE').CLIENT_SECRET,
                            config.get('GOOGLE_DRIVE').REDIRECT_URL
                        );

                        var scopes = [
                            'https://www.googleapis.com/auth/drive'
                        ];

                        oauth2Client.setCredentials(request.auth.credentials.user.OBJECT_SETTINGS.GOOGLE_DRIVE.tokens);

                        var drive = google.drive({
                            version: 'v3',
                            auth: oauth2Client
                        });

                        drive.files.delete({
                            fileId: request.auth.credentials.user.OBJECT_SETTINGS.GOOGLE_DRIVE.FOLDER_ID
                        }, function(err, res) {
                            if (err)
                                callback(err);

                            else
                                callback(null);
                        });
                    } else
                        callback(null);

                },
                function(callback) {
                    db.collection(config.get('USER_COLLECTION')).updateOne({
                        _id: new mongo.ObjectID(request.auth.credentials.user._id)
                    }, {
                        $unset: {
                            'OBJECT_SETTINGS.GOOGLE_DRIVE': 1
                        }
                    }, function(err, res) {
                        if (err)
                            callback(err);

                        else {
                            console.log(res.result.n + ' records updated.');
                            var user = request.auth.credentials.user;

                            delete user.OBJECT_SETTINGS.GOOGLE_DRIVE;

                            service.changeSessionData(request, user, null);

                            callback(null);
                        }
                    });
                }
            ], function(err, result) {
                if (err)
                    service.handleError(reject, err);

                else
                    resolve('done');
            });
        });
        return promise;
    }

    return this;
}
