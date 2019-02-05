module.exports = function(service, io) {
    var config = require('../config/config')();
    var _async = require('async');
    var mongo = require('mongodb');
    var gdriveHandlers = require('./storages/gdrive.js')(service, io);
    var azureHandlers = require('./storages/azure.js')(service, io);
    var s3Handlers = require('./storages/s3.js')(service, io);
    var db = config.getDB();

    var imageNameIdentifiers = {
        S3: 'Key',
        GOOGLE_DRIVE: 'name',
        AZURE_STORAGE: 'name'
    }

    var imageIdentifiers = {
        S3: 'Key',
        GOOGLE_DRIVE: 'id',
        AZURE_STORAGE: 'name'
    }

    this.startSynchronizer = function(msg, projectId) {

        console.log(msg);

        var totalImageInAccount = msg.totalImageInAccount;
        var tillTotal = totalImageInAccount;
        var socket;

        console.log(Object.keys(require('../helper/io').sockets));

        if(require('../helper/io').sockets[msg.queueName])
            socket = require('../helper/io').sockets[msg.queueName].socket;

        if(socket)
            socket.emit('progressText', 'Authenticating to Data Storage...');

        var todaysdate = '';
        var activeStorage = msg.storage;

        console.log({activeStorage});

        //waterfall begins :)
        _async.waterfall([
            function(callback) {
                var fn = function(err, data) {
                    console.log(err, data);

                    if (err)
                        callback(err);

                    else {
                        console.log('Got', data.length, 'files');

                        data = data.filter((item) => service.ifFileIsMedia(item[imageNameIdentifiers[activeStorage]]));

                        console.log('Got', data.length, 'files after ifFileIsMedia filter');

                        callback(null, data);
                    }
                };

                if (activeStorage == 'S3')
                    s3HandlersHandlers.getFilesS3(msg.userData, projectId, socket, fn);

                else if (activeStorage == 'GOOGLE_DRIVE')
                    gdriveHandlers.getFilesGoogleDrive(msg.userData, projectId, socket, fn);

                else if (activeStorage == 'AZURE_STORAGE')
                    azureHandlers.getFilesAzure(msg.userData, projectId, socket, fn);

                else {
                    if(socket)
                        socket.emit('progressText', 'Invalid storage type ...');
                    callback('Invalid storage type');
                }
            },
            /***********************Delete unclassified Images***********************/
            function(files, callback) {
                db.collection(config.get('IMAGES_COLLECTION')).deleteMany({
                    USER_OID: new mongo.ObjectID(msg.queueName),
                    OBJECT_STORAGE_NAME: activeStorage,
                    PROJECT_ID: projectId,
                    STATUS: 'NEW'
                }, function(err, res) {
                    if (err)
                        callback(err);

                    else {
                        console.log(res.result.n, 'images deleted which had status NEW...')

                        tillTotal = tillTotal - res.result.n;
                        callback(null, files)
                    }
                });
            },
            function(files, callback) {
                db.collection(config.get('WORKING_IMAGES_COLLECTION')).deleteMany({
                    OWNER_OID: new mongo.ObjectID(msg.queueName),
                    PROJECT_ID: projectId
                }, function(err, res) {
                    if (err)
                        callback(err)

                    else {
                        console.log(res.result.n, 'images deleted from working image collection...')

                        callback(null, files)
                    }
                });
            },
            function(files, callback) {
                console.log('Inserting files');
                console.log(files);

                let imagesIdFromStorage = [];
                let imageId = imageIdentifiers[activeStorage];

                for (let i = 0; i < files.length; i++)
                    imagesIdFromStorage.push(files[i][imageId]);

                //Here checking if image has STATUS 'ASSIGNED' and deleted from activeStorage
                db.collection(config.get('IMAGES_COLLECTION')).deleteMany({
                    USER_OID: new mongo.ObjectID(msg.queueName),
                    OBJECT_STORAGE_NAME: activeStorage,
                    PROJECT_ID: projectId,
                    STATUS: 'ASSIGNED',
                    ORIGINAL_OBJECT_NAME: {
                        $nin: imagesIdFromStorage
                    }
                }, function(err, res) {
                    if (err) callback(err)
                    else {
                        console.log(res.result.n, 'images deleted which had status ASSIGNED...')
                        tillTotal = tillTotal - res.result.n;
                        callback(null, files)
                    }
                })
            },
            /***********************************************************************/
            function(files, callback) {
                var batch = db.collection(config.get('IMAGES_COLLECTION')).initializeUnorderedBulkOp({
                    useLegacyOps: true
                });
                var count = 0;

                var shouldStopflag = false;
                var deleteNo;

                todaysdate = new Date().getTime();

                _async.eachSeries(files, function(imageObjectToBeInserted, eachSeriesCallback) {
                        count++;

                        var ORIGINAL_OBJECT_NAME = (imageObjectToBeInserted[imageIdentifiers[msg.storage]]);
                        var OBJECT_NAME = (imageObjectToBeInserted[imageNameIdentifiers[msg.storage]]);
                        var IMAGE_WIDTH = (imageObjectToBeInserted.imageMediaMetadata ? imageObjectToBeInserted.imageMediaMetadata.width : 0);
                        var IMAGE_HEIGHT = (imageObjectToBeInserted.imageMediaMetadata ? imageObjectToBeInserted.imageMediaMetadata.height : 0);

                        var imageObject = {
                            USER_OID: new mongo.ObjectID(msg.queueName),
                            ORIGINAL_OBJECT_NAME: ORIGINAL_OBJECT_NAME,
                            OBJECT_NAME: OBJECT_NAME,
                            OBJECT_STORAGE_NAME: activeStorage,
                            STATUS: 'NEW',
                            OBJECT_DETAILS_LOAD_DATE: todaysdate,
                            PROJECT_ID: projectId,
                            IMAGE_WIDTH: IMAGE_WIDTH,
                            IMAGE_HEIGHT: IMAGE_HEIGHT
                        };

                        batch.find({
                            ORIGINAL_OBJECT_NAME: ORIGINAL_OBJECT_NAME,
                            USER_OID: new mongo.ObjectID(msg.queueName),
                            PROJECT_ID: projectId,
                            OBJECT_STORAGE_NAME: activeStorage
                        }).upsert().updateOne({
                            $setOnInsert: imageObject
                        });

                        var completed = (count / files.length * 100);

                        if(socket) {
                            socket.emit('progress', JSON.stringify({
                                completed: completed
                            }));
                        }

                        if (((count % config.get('SYNCHRONIZER').BATCH_LIMIT == 0) || (count == files.length)) && !shouldStopflag) {
                            batch.execute(function(err, result) {
                                if (err)
                                    eachSeriesCallback(err);

                                else {

                                    console.log({
                                        'result.nInserted': result.nInserted,
                                        'records upsetred': result.nUpserted
                                    });

                                    tillTotal = result.nUpserted + tillTotal;

                                    batch = db.collection(config.get('IMAGES_COLLECTION')).initializeUnorderedBulkOp({
                                        useLegacyOps: true
                                    });

                                    if (msg.userData.SUBSCRIPTION_FLAG.LIMITS.IMAGE_LIMIT != -1 && tillTotal >= msg.userData.SUBSCRIPTION_FLAG.LIMITS.IMAGE_LIMIT) {
                                        shouldStopflag = true;
                                        deleteNo = tillTotal - msg.userData.SUBSCRIPTION_FLAG.LIMITS.IMAGE_LIMIT;
                                        eachSeriesCallback(true);
                                    } else {
                                        eachSeriesCallback(null);
                                    }
                                }
                            });
                        } else
                            eachSeriesCallback(null);
                    },
                    function(err) {
                        if (err && deleteNo != null && deleteNo > 0) {
                            var _ids = db.collection(config.get('IMAGES_COLLECTION')).find({
                                    USER_OID: new mongo.ObjectID(msg.queueName)
                                }, {
                                    _id: 1
                                })
                                .limit(deleteNo)
                                .sort({
                                    _id: -1
                                })
                                .map(function(doc) {
                                    return doc._id;
                                })
                                .toArray()
                                .then((removeIdsArray) => {
                                    console.log('Docs to be removed ', removeIdsArray);

                                    db.collection(config.get('IMAGES_COLLECTION')).remove({
                                        _id: {
                                            $in: removeIdsArray
                                        }
                                    })
                                })
                                .then(() => callback(null))
                                .catch(err => callback(err));
                        } else if (err == true) {
                            callback(null);
                        } else {
                            callback(err ? err : null);
                        }
                    });
            }
        ], function(err) {
            if (err)
                console.error(err);

            else {
                var date = new Date();

                socket.emit('lastSynchronizationDate', date.toUTCString());
                console.log('Synchronizer completed at ', date.toUTCString());

                msg.userData.PROJECTS[projectId].LAST_SYNCHRONIZATION_DATE = date.getTime();
                db.collection(config.get('USER_COLLECTION')).update({
                    _id: new mongo.ObjectID(msg.queueName)
                }, {
                    $set: {
                        PROJECTS: msg.userData.PROJECTS
                    }
                }, function(err, result) {
                    if (err)
                        console.error(err);

                    else {
                        console.log(result.result.n, 'records updated');
                        console.log('Last Synchronzation date updated');
                    }
                });

                db.collection(config.get('IMAGES_COLLECTION')).count({
                    USER_OID: new mongo.ObjectID(msg.queueName),
                    PROJECT_ID: projectId
                }, function(err, count) {
                    if (err)
                        service.handleError(reject, 'Authentication Failure');

                    else {
                        socket.emit('totalCount', count);
                    }
                });
            }
        });
    }

    return this;
}
