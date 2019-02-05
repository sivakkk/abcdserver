module.exports = function (service) {
    var config = require('../config/config')();
    var _async = require('async');
    var AWS = require('aws-sdk');
    var mongo = require('mongodb');
    var { google } = require('googleapis');
    var OAuth2 = google.auth.OAuth2;
    var db = config.getDB();
    var oauth2Client = new OAuth2(
        config.get('GOOGLE_DRIVE').CLIENT_ID,
        config.get('GOOGLE_DRIVE').CLIENT_SECRET,
        config.get('GOOGLE_DRIVE').REDIRECT_URL
    );

    this.trainingImagesHandler = function (request, h) {

        var promise = new Promise((resolve, reject) => {
            console.log('querying for :' + request.auth.credentials.user.CERT_LEVEL + 1, request.auth.credentials.user.CHECKPOINT_PASSED + 1);
            db.collection(config.get('TRAINING_IMAGES')).aggregate([{
                    // db.collection("training_dataset_new").aggregate([{
                    $match: {
                        CERT_LEVEL: request.auth.credentials.user.CERT_LEVEL + 1,
                        CERT_LEVEL_CHECK_POINT: request.auth.credentials.user.CHECKPOINT_PASSED + 1
                    }
                },
                {
                    $sample: {
                        size: config.get('QUESTIONS_PER_CHECKPOINT')
                    }
                }
            ], function (err, item) {
                if (err)
                    service.handleError(reject, err);

                else {
                    resolve({
                        item
                    });
                }
            });
        });

        return promise;
    }

    this.updateCertificationHandler = function (request, h) {
        // console.log(request)
        var promise = new Promise((resolve, reject) => {
            if (request.auth.credentials.user.CHECKPOINT_PASSED == config.get('CHECKPOINTS_PER_LEVEL') - 1) {

                if(request.auth.credentials.user.CERT_LEVEL === 4){
                    db.collection(config.get('USER_COLLECTION')).update({
                        _id: new mongo.ObjectId(request.auth.credentials.user._id.toString()),
                        USER_TYPE : request.auth.credentials.user.USER_TYPE
                    }, {
                        $set : {
                            BASIC_TRAINING_COMPLETED : true
                        }
                    },
                    function(err, res){
                        if(err) service.handleError(reject, err);
                        else{
                            var user = request.auth.credentials.user;

                            user.BASIC_TRAINING_COMPLETED = true;

                            request.cookieAuth.set({
                                user
                            });
                            resolve(res);
                        }
                    }
                    )
                }

                db.collection(config.get('USER_COLLECTION')).update({
                        _id: new mongo.ObjectID(request.auth.credentials.user._id.toString()),
                        USER_TYPE: request.auth.credentials.user.USER_TYPE
                    }, {
                        $set: {
                            CHECKPOINT_PASSED: 0,
                            CERT_LEVEL: request.auth.credentials.user.CERT_LEVEL + 1
                        }
                    },
                    function (err, res) {
                        if (err) {
                            console.log('err with updating certification - DB');
                            service.handleError(reject, err);
                        } else {
                            var user = request.auth.credentials.user;

                            user.CHECKPOINT_PASSED = 0;
                            user.CERT_LEVEL = user.CERT_LEVEL + 1;

                            request.cookieAuth.set({
                                user
                            });

                            resolve(user);
                        }
                    });
            } else {
                try {
                    db.collection(config.get('USER_COLLECTION')).update({
                        _id: new mongo.ObjectID(request.auth.credentials.user._id.toString())
                    }, {
                        $set: {
                            CHECKPOINT_PASSED: request.auth.credentials.user.CHECKPOINT_PASSED + 1
                        }
                    });
                    var user = request.auth.credentials.user;

                    user.CHECKPOINT_PASSED = user.CHECKPOINT_PASSED + 1;
                    request.cookieAuth.set({
                        user
                    });

                    resolve(user);
                } catch (e) {
                    service.handleError(reject, err);
                }
            }
        });

        return promise;
    }

    this.getTrainingImageHandler = function (request, h) {
        var promise = new Promise((resolve, reject) => {

            var currentTokens = {};

            _async.waterfall([
                function (callback) {
                    db.collection(config.get('MODEL_COLLECTION')).findOne({ }, function (err, doc) {
                        if(err)
                            callback(err);

                        else {
                            currentTokens = doc.TRAINING_IMAGE_LOCATION.GOOGLE_DRIVE;
                            callback(null, currentTokens);
                        }
                    })
                }
                , function (tokens, callback) {
                    if (tokens.expiry_date < (new Date()).getTime()) {
                        console.log('Google Drive Access Token has expired');

                        oauth2Client.setCredentials({
                            refresh_token : tokens.refresh_token
                        });

                        oauth2Client.refreshAccessToken(function (err, newTokens) {
                            if(err)
                                callback(err);

                            else {
                                db.collection(config.get('MODEL_COLLECTION')).updateOne({ }, {
                                    $set : {
                                        'TRAINING_IMAGE_LOCATION.GOOGLE_DRIVE' : newTokens
                                    }
                                }, function (err, result) {
                                    if(err)
                                        callback(err);

                                    else {
                                        callback(null, newTokens);
                                    }
                                })
                            }

                        });
                    }

                    else
                        callback(null, tokens);

                }, function (tokens, callback) {

                    oauth2Client.setCredentials(tokens);

                    var drive = google.drive({
                        version: 'v2',
                        auth: oauth2Client
                    });

                    drive.files.get({
                        fileId: request.payload['ORIGINAL_OBJECT_NAME'],
                        alt: 'media'
                    }, {
                        responseType: 'arraybuffer',
                        encoding: null
                    }, function(err, response) {
                        if (err)
                            callback(err);

                        else
                            callback(null, response);
                    });
                }, function (response, callback) {

                    var imageType = response.headers['content-type'];
                    var base64 = new Buffer(response.data, 'utf8').toString('base64');
                    var dataURI = 'data:' + imageType + ';base64,' + base64;

                    callback(null, dataURI);
                }
            ], function (err, result) {
                if(err)
                    reject(err);

                else
                    resolve({data: result});
            });
        });

        return promise;

    }

    return this;
}
