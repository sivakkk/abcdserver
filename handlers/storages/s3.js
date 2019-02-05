module.exports = function(service) {
    var config = require('../../config/config')();
    var _async = require('async');
    var mongo = require('mongodb');
    var {
        google
    } = require('googleapis');
    var sizeOf = require('image-size');
    var OAuth2 = google.auth.OAuth2;
    var db = config.getDB();

    var oauth2Client = new OAuth2(
        config.get('GOOGLE_DRIVE').CLIENT_ID,
        config.get('GOOGLE_DRIVE').CLIENT_SECRET,
        config.get('GOOGLE_DRIVE').REDIRECT_URL
    );
    var vm = this;

    var scopes = ['https://www.googleapis.com/auth/drive.readonly'];

    this.getFileS3 = function(request, s3, bucket, key, requiredData) {
        // requiredData argument is optional. If provided as 'image_only', the dimensions of image won't be updated in DB
        var sizeOf = require('image-size');

        var promise = new Promise((resolve, reject) => {
            s3.getObject({
                Bucket: bucket,
                Key: key
            }, function(err, file) {
                if (err)
                    reject(err);

                else {
                    var dimension = sizeOf(file.Body);
                    var content = vm.encode(file.Body, key);

                    if (requiredData && requiredData === 'image_only') { // If function called from view image, no need to update dimensions of image
                        resolve({
                            content: content,
                            dimension: dimension
                        });
                    } else {
                        db.collection(config.get('IMAGES_COLLECTION')).update({
                            ORIGINAL_OBJECT_NAME: key,
                            USER_OID: new mongo.ObjectId((request.auth.credentials.admin ? request.auth.credentials.admin._id : request.auth.credentials.user._id))
                        }, {
                            $set: {
                                IMAGE_WIDTH: dimension.width,
                                IMAGE_HEIGHT: dimension.height,
                                IMAGE_MIME_TYPE: dimension.type,
                                IMAGE_CONTENT_LENGTH: content.length
                            }
                        }, function(err, result) {
                            if (err)
                                vm.handleError(reject, err);

                            else {
                                if (result.result.n > 0)
                                    console.log('Image width height and MIME_TYPE updated.');

                                resolve({
                                    content: content,
                                    dimension: dimension
                                });
                            }
                        });
                    }
                }
            });
        });

        return promise;
    }

    this.getFilesS3 = function(user, projectId, socket, callback) {
        var AWS = require('aws-sdk');

        var s3;

        try {
            AWS.config.update({
                accessKeyId: user.PROJECTS[projectId].STORAGE_DETAILS.S3.ACCESS_KEY,
                secretAccessKey: user.PROJECTS[projectId].STORAGE_DETAILS.S3.SECRET_KEY,
                region: user.PROJECTS[projectId].STORAGE_DETAILS.S3.REGION_NAME
            });

            s3 = new AWS.S3();
        } catch (e) {
            console.log(e);
            socket.emit('progressText', 'Authentication to S3 failed with the provided credentials');

            callback(err);
        }

        socket.emit('progressText', 'Checking for files on your s3 bucket.');

        var isTruncated = true;
        var continuationToken = '';
        var files = new Array();

        _async.whilst(function() {
                return isTruncated;
            },
            function(whilstCallback) {
                var option = {
                    Bucket: user.PROJECTS[projectId].STORAGE_DETAILS.S3.BUCKET_NAME
                };

                if (continuationToken != '')
                    option['ContinuationToken'] = continuationToken;

                s3.listObjectsV2(option, function(err, data) {
                    if (err)
                        whilstCallback(err);

                    else {
                        files = files.concat(data.Contents);
                        isTruncated = data.IsTruncated;

                        if (data.IsTruncated)
                            continuationToken = data.NextContinuationToken;

                        whilstCallback(null);
                    }
                });
            },
            function(err, n) {
                if (err) {
                    if (err.code == 'NoSuchBucket') {
                        socket.emit('progressText', 'Bucket name doesn\'t exits');
                    }

                    callback(err);
                } else
                    callback(null, files);
            });
    }

    return this;
}
