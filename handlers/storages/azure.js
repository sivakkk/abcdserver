module.exports = function(service) {
    const config = require('../../config/config')();
    const _async = require('async');
    const mongo = require('mongodb');
    const sizeOf = require('image-size');
    const azure = require('azure-storage');
    const btoa = require('btoa');

    var db = config.getDB();
    var vm = this;

    this.getFilesAzure = function(userData, projectId, socket, callback) {
        console.log('getFilesAzure');

        var continuationToken = null;
        var files = new Array();
        var connString = userData.PROJECTS[projectId].STORAGE_DETAILS.AZURE_STORAGE.CONNECTION_STRING;

        if(userData.PROJECTS[projectId].STORAGE_DETAILS.AZURE_STORAGE.AZURE_STORAGE_TYPE == 'blob-storage') {
            var blobService = azure.createBlobService(connString);
            var containerName = userData.PROJECTS[projectId].STORAGE_DETAILS.AZURE_STORAGE.CONTAINER_NAME;

            _async.doWhilst(function (whilstCallback) {
                blobService.listBlobsSegmented(containerName, continuationToken, function (err, data) {
                    if (err) {
                        console.error(err);
                    } else {
                        console.log(data.entries.length, 'files were found');

                        continuationToken = data.continuationToken;
                        files = files.concat(data.entries);

                        whilstCallback(null);
                    }
                });
            }, function () {
                return continuationToken != null;
            }, function (err) {
                if(err)
                    callback(err);

                else
                    callback(null, files);
            });
        }

        else if(userData.PROJECTS[projectId].STORAGE_DETAILS.AZURE_STORAGE.AZURE_STORAGE_TYPE == 'file-storage') {
            var fileService = azure.createFileService(connString);
            var share = userData.PROJECTS[projectId].STORAGE_DETAILS.AZURE_STORAGE.SHARE_NAME;
            var directory = userData.PROJECTS[projectId].STORAGE_DETAILS.AZURE_STORAGE.DIRECTORY_NAME;

            _async.doWhilst(function (whilstCallback) {
                console.log('getting files');

                fileService.listFilesAndDirectoriesSegmented(share, directory, continuationToken, (err, data) => {
                    if (err) {
                        console.error(err);
                    } else {
                        console.log(data.entries.files.length, 'files were found');

                        continuationToken = data.continuationToken;

                        files = files.concat(data.entries.files);

                        whilstCallback(null);
                    }
                });
            }, function () {
                return continuationToken != null;
            }, function (err) {
                if(err)
                    callback(err);

                else {
                    callback(null, files);
                }
            });
        }

        else
            callback('Unknown Azure Storage Type');
    }

    this.getFileAzure = function(userData, fileName, projectId, callback) {
        var connString = userData.PROJECTS[projectId].STORAGE_DETAILS.AZURE_STORAGE.CONNECTION_STRING;
        var stream;

        _async.waterfall([
            function (waterfallCallback) {
                if(userData.PROJECTS[projectId].STORAGE_DETAILS.AZURE_STORAGE.AZURE_STORAGE_TYPE == 'blob-storage') {
                    console.log('blob-storage');

                    var blobService = azure.createBlobService(connString);
                    var containerName = userData.PROJECTS[projectId].STORAGE_DETAILS.AZURE_STORAGE.CONTAINER_NAME;

                    stream = blobService.createReadStream(containerName, fileName);
                }

                else if(userData.PROJECTS[projectId].STORAGE_DETAILS.AZURE_STORAGE.AZURE_STORAGE_TYPE == 'file-storage') {
                    console.log('file-storage');

                    var fileService = azure.createFileService(connString);
                    var share = userData.PROJECTS[projectId].STORAGE_DETAILS.AZURE_STORAGE.SHARE_NAME;
                    var directory = userData.PROJECTS[projectId].STORAGE_DETAILS.AZURE_STORAGE.DIRECTORY_NAME;

                    stream = fileService.createReadStream(share, directory, fileName);
                }

                var fileContent = '';

                stream.on('error', (err) => {
                    waterfallCallback(err);
                });

                stream.on('data', (data) => {
                    var dimension = sizeOf(data);

                    if(fileContent == '')
                        fileContent = config.get('IMAGE_MIME_TYPE')[dimension.type];

                    fileContent += btoa(data);

                    waterfallCallback(null, fileContent, dimension);
                });
            },
            function (fileContent, dimension, waterfallCallback) {
                db.collection(config.get('IMAGES_COLLECTION')).update({
                    OBJECT_NAME: fileName,
                    USER_OID: new mongo.ObjectID(userData._id.toString())
                }, {
                    $set: {
                        IMAGE_WIDTH: dimension.width,
                        IMAGE_HEIGHT: dimension.height,
                        IMAGE_MIME_TYPE: dimension.type,
                        IMAGE_CONTENT_LENGTH: fileContent.length
                    }
                }, function(err, result) {
                    if (err)
                        waterfallCallback(err);

                    else {
                        if (result.result.n > 0)
                            console.log('Image width height and MIME_TYPE updated.');

                        waterfallCallback(null, {
                            dataURI: fileContent,
                            width: dimension.width,
                            height: dimension.height
                        });
                    }
                });
            }
        ], function (err, data) {
            if(err)
                callback(err);

            else
                callback(null, data);
        })
    }

    return this;
}
