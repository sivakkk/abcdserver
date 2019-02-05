module.exports = function(service, io) {
    var config = require('../config/config')();
    var _async = require('async');
    var mongo = require('mongodb');
    var db = config.getDB();

    this.startSynchronizer = function(user, projectId, doneCallback) {
        //collect user's socket
        var socket = require('../helper/io').sockets[user._id.toString()].socket;
        socket.emit('progressText', 'Synchronizer has started');

        var deleteQueue = new Array();          //it will contain all the images which needs to be deleted
        var insertQueue = new Array();          //it will contain all the new images which needs to be inserted in the database

        var dbImagesArray = new Array();        //it will contain all the images which are already present in the database
        var dbImagesSet = new Set();            //set of dbImagesArray (for checking uniques)

        var storageImagesArray = new Array();   //it will contain all the images which are present in storage like S3 and google drive
        var storageImagesSet = new Set();       //set of storageImagesArray (for checking uniques)

        _async.waterfall([
            function (callback) {
                //finding all images already added for all the project
                db.collection(config.get('IMAGES_COLLECTION')).find({
                    USER_OID : new mongo.ObjectID(user._id.toString())
                }).toArray(function (err, items) {
                    if(err) {
                        callback(err);
                        socket.emit('progressText', 'Error while getting images from Database');
                    }

                    else {
                        //inform user about number of images already present in the database
                        socket.emit('progressText', 'Found ' + items.length + ' images in the Database');

                        dbImagesArray = items.map(function (item) {
                            //in S3 API file, name is called OBJECT_NAME
                            //in Google Drive API, file name is called ORIGINAL_OBJECT_NAME
                            var objectNamekey = user.PROJECTS[item.PROJECT_ID].ACTIVE_STORAGE == 'S3' ? 'OBJECT_NAME' : 'ORIGINAL_OBJECT_NAME';

                            //adding all the elements in a set
                            dbImagesSet.add(item[objectNamekey]);

                            //only selective fields would be added in the array
                            return { name : item[objectNamekey], userId : user._id, projectId : item.PROJECT_ID };
                        });

                        callback(null);
                    }
                });
            }, function (callback) {
                var projectsArray = Object.keys(user.PROJECTS);

                //iterate through all the projects and store the images in the storageImagesArray
                _async.each(projectsArray, function (projectItem, eachCallback) {
                    if (user.PROJECTS[projectId].ACTIVE_STORAGE == 'S3') {
                        // service.getAllFilesFromS3(user, projectId, socket, function (err, data) {
                        //     if(err)
                        //         callback(err);
                        //
                        //     else {
                        //         storageImagesArray = data.map(function (item) {
                        //
                        //             //adding all the elements in a set
                        //             storageImagesSet.add(item.key);
                        //
                        //             //only selective fields would be added in the array
                        //             return {
                        //                 fileName : item.key,
                        //                 fileId : item.key,
                        //                 storage : 'S3'
                        //             };
                        //         });
                        //
                        //         callback(null);
                        //     }
                        // });
                    } else if (user.PROJECTS[projectItem].ACTIVE_STORAGE == 'GOOGLE_DRIVE') {
                        var gdrive = require('./storages/gdrive.js')(service, io);

                        gdrive.getFiles(user, projectItem, socket, function (err, data) {
                            if(err)
                                callback(err);

                            else {
                                storageImagesArray.concact(data.map(function (item) {

                                    //adding all the elements in a set
                                    storageImagesSet.add(item.id);

                                    //only selective fields would be added in the array
                                    return {
                                        fileName : item.name,
                                        fileId : item.id,
                                        projectId: projectItem,
                                        storage : 'GOOGLE_DRIVE',
                                        IMAGE_WIDTH: item.imageMediaMetadata.width,
                                        IMAGE_HEIGHT: item.imageMediaMetadata.height
                                    };
                                }));

                                callback(null);
                            }
                        });
                    }
                });
            }, function (callback) {
                dbImagesArray.forEach(function (dbImage) {
                    //if the images is present in database and not in s3 or google drive
                    //this image needs to be deleted
                    if(!storageImagesSet.has(dbImage.name))
                        deleteQueue.push(dbImage);
                });

                //informing user about the number of images which needs to be deleted
                socket.emit('progressText', deleteQueue.length + ' images to be deleted from Database');

                storageImagesArray.forEach(function (storageImage) {
                    //if the image is present in storage (s3 or google drive) and not in database
                    //this image needs to be inserted
                    if(!dbImagesSet.has(storageImage.fileId))
                        insertQueue.push(storageImage);
                });

                //infrom the user about the number of images which needs to be added
                socket.emit('progressText', insertQueue.length + ' images to be added in Database');

                callback(null);
            }, function (callback) {
                if(deleteQueue.length == 0) {
                    callback(null);
                    return;
                }

                //executing the deleteQueue Operation
                var batch = db.collection(config.get('IMAGES_COLLECTION')).initializeUnorderedBulkOp({
                    useLegacyOps: true
                });

                deleteQueue.forEach(function (item) {
                    if(item.storage == 'S3') {
                        bulk.find(({
                            OBJECT_NAME : item.name,
                            USER_OID : new mongo.ObjectID(user._id.toString()),
                            PROJECT_ID : projectId,
                            OBJECT_STORAGE_NAME : 'S3'
                        }).removeOne();
                    }

                    else if(item.storage == 'GOOGLE_DRIVE') {
                        deleteQueue.forEach(function (item) {
                            bulk.find({
                                ORIGINAL_OBJECT_NAME : item.name,
                                USER_OID : new mongo.ObjectID(user._id.toString()),
                                PROJECT_ID : projectId,
                                OBJECT_STORAGE_NAME : 'GOOGLE_DRIVE'
                            }).removeOne();
                        });
                    }
                });

                batch.execute(function (err, result) {
                    if(err)
                        callback(err);

                    else {
                        console.log(result.nDeleted +' images successfully removed from image collection');
                        socket.emit('progressText', result.nDeleted +' images successfully removed from image database');

                        callback(null);
                    }
                });
            }, function (callback) {
                if(insertQueue.length == 0) {
                    callback(null);
                    return;
                }

                //check the number of images again
                //this might might have changed, because some images would have been deleted after execution of deletion queue
                db.collection(config.get('IMAGES_COLLECTION')).count({
                    USER_OID : new mongo.ObjectID(user._id.toString())
                }, function (err, count) {
                    if(err)
                        callback(err);

                    else {
                        //                allowed limit                        already in database     new images to be added
                        var diff = user.SUBSCRIPTION_FLAG.LIMITS.IMAGE_LIMIT - (count + insertQueue.length);

                        //not all new images could be added
                        //only a part of images would be added
                        if (diff < 0) {
                            socket.emit('progressText', 'You have ' + (-diff) + ' more images than the allowed limit');

                            //only a part of images would be added
                            // images to be added = limit - new images count
                            socket.emit('progressText', 'Only ' + (user.SUBSCRIPTION_FLAG.LIMITS.IMAGE_LIMIT - count) + ' images would be added.');

                            //remove the extra images from the insert Queue
                            insertQueue = insertQueue.slice(0, user.SUBSCRIPTION_FLAG.LIMITS.IMAGE_LIMIT - count + 1);
                        }

                        var batch = db.collection(config.get('IMAGES_COLLECTION')).initializeUnorderedBulkOp({
                            useLegacyOps: true
                        });

                        insertQueue.forEach(function (item) {
                            batch.insert({
                                USER_OID: new mongo.ObjectID(user._id.toString()),
                                PROJECT_ID: projectId,
                                ORIGINAL_OBJECT_NAME: item.fileId,
                                OBJECT_NAME: item.fileName,
                                OBJECT_STORAGE_NAME: item.storage,
                                STATUS: 'NEW',
                                OBJECT_DETAILS_LOAD_DATE: (new Date).getTime(),
                                IMAGE_WIDTH: item.IMAGE_WIDTH,
                                IMAGE_HEIGHT: item.IMAGE_HEIGHT
                            });
                        });

                        batch.execute(function (err, result) {
                            if(err)
                                callback(err);

                            else {
                                console.log(result.nInserted +' images were inserted');
                                socket.emit('progressText', result.nInserted +' images were inserted');

                                callback(null);
                            }
                        });
                    }
                });
            }, function (callback) {
                _async.parallel([
                    function (parallelCallback) {
                        //let the user know about the final count of images
                        db.collection(config.get('IMAGES_COLLECTION')).count({
                            USER_OID: new mongo.ObjectID(user._id),
                            PROJECT_ID: projectId
                        }, function(err, count) {
                            if (err)
                                parallelCallback(err);

                            else {
                                socket.emit('totalCount', count);

                                parallelCallback(null);
                            }
                        });
                    }, function (parallelCallback) {
                        var date = new Date();

                        //update the last Synchronzation date in the database
                        user.PROJECTS[projectId].LAST_SYNCHRONIZATION_DATE = date.getTime();

                        db.collection(config.get('USER_COLLECTION')).update({
                            _id: new mongo.ObjectID(user._id)
                        }, {
                            $set: {
                                PROJECTS: user.PROJECTS
                            }
                        }, function(err, result) {
                            if (err)
                                parallelCallback(err);

                            else {
                                console.log('Last Synchronzation date updated');

                                socket.emit('progressText', 'Synchronization completed');
                                socket.emit('lastSynchronizationDate', date.toUTCString());

                                parallelCallback(null);
                            }
                        });
                    }
                ], function (err) {
                    callback(err ? err, null);
                });
            }
        ], function (err) {
            console.log(err ? err : 'Synchronzation completed for ', user.EMAIL_ID);
        });
    }

    return this;
}
