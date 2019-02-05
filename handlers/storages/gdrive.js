module.exports = function(service) {
    var config = require('../../config/config')();
    var _async = require('async');
    var mongo = require('mongodb');
    var {
        google
    } = require('googleapis');
    var sizeOf = require('image-size');
    var OAuth2 = google.auth.OAuth2;
    var fs = require('fs');
    var requestsLib = require('request');
    var stream = require('stream');
    var db = config.getDB();

    var oauth2Client = new OAuth2(
        config.get('GOOGLE_DRIVE').CLIENT_ID,
        config.get('GOOGLE_DRIVE').CLIENT_SECRET,
        config.get('GOOGLE_DRIVE').REDIRECT_URL
    );
    var vm = this;

    var scopes = ['https://www.googleapis.com/auth/drive.readonly'];

    this.gdriveoAuth = function(request, h) {
        let state = JSON.stringify({
            "userId": request.auth.credentials.user._id.toString(),
            "projectId": request.query.projectId
        })
        encodedState = encodeURIComponent(state)

        return oauth2Client.generateAuthUrl({
            // 'online' (default) or 'offline' (gets refresh_token)
            access_type: 'offline',
            scope: scopes,
            state: encodedState,
            prompt: 'consent' // To get refresh token each time when user connects g drive
        });
    }

    vm.gdriveoAuthCallback = function(request, h) {
        var promise = new Promise(function(resolve, reject) {
            _async.waterfall([
                function(callback) {
                    oauth2Client.getToken(request.payload.code, function(err, tokens) {
                        if (err)
                            callback(err);

                        else {
                            oauth2Client.setCredentials({
                                access_token: tokens.access_token,
                                refresh_token: tokens.refresh_token
                            });
                            var drive = google.drive({
                                version: 'v3',
                                auth: oauth2Client,
                            });

                            drive.about.get({
                                auth: oauth2Client,
                                fields: 'user'
                            }, function(err, response) {
                                if (err) {
                                    service.handleError(reject, err);
                                } else {
                                    // Now tokens contains an access_token and an optional refresh_token. Save them.
                                    callback(null, tokens, response.data.user.emailAddress);
                                }
                            });
                        }
                    });
                },

                function(tokens, CONNECTED_ACCOUNT, callback) {
                    db.collection(config.get('USER_COLLECTION')).findOne({
                        _id: new mongo.ObjectID(request.auth.credentials.user._id)
                    }, {
                        PASSWORD: 0
                    }, function(err, result) {
                        if (err)
                            service.handleError(reject, err);

                        if (result)
                            callback(null, tokens, CONNECTED_ACCOUNT, result)
                    })
                },

                function(tokens, CONNECTED_ACCOUNT, user, callback) {
                    var sdata = {
                        tokens: tokens,
                        IS_CONNECTED: true,
                        LAST_CONNECTED_AT: new Date().getTime(),
                        CONNECTED_ACCOUNT: CONNECTED_ACCOUNT
                    };

                    let state = JSON.parse(decodeURIComponent(request.payload.state));

                    user.PROJECTS[state.projectId].STORAGE_DETAILS.GOOGLE_DRIVE = sdata;
                    user.PROJECTS[state.projectId].ACTIVE_STORAGE = 'GOOGLE_DRIVE';

                    var query = {
                        $set: {
                            PROJECTS: user.PROJECTS
                        }
                    };

                    db.collection(config.get('USER_COLLECTION')).findOneAndUpdate({
                        _id: new mongo.ObjectID(state.userId)
                    }, query, function(err, res) {
                        if (err)
                            service.handleError(reject, err);

                        else {

                            if (!user.OBJECT_SETTINGS)
                                user.OBJECT_SETTINGS = {};

                            user.OBJECT_SETTINGS.GOOGLE_DRIVE = sdata;
                            user.ACTIVE_STORAGE = 'GOOGLE_DRIVE';

                            // service.changeSessionData(request, user, null);

                            resolve({
                                msg: 'done',
                                storage_details: user.OBJECT_SETTINGS
                            });
                        }
                    });
                }
            ], function(err, result) {
                if (err)
                    // service.handleError(reject, err, 'Error while creating folder on your google drive.');    // Replaced this line with below line
                    service.handleError(reject, err, 'Error while connecting with your google drive.');
                else
                    resolve('done');
            })
        });

        return promise;
    }

    function createNewFolder(drive, folderName, callback) {
        var fileMetadata = {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder'
        };
        drive.files.create({
            resource: fileMetadata,
            fields: 'id'
        }, function(err, file) {
            if (err)
                callback(err);

            else
                callback(null, file.data);
        });
    }

    //get files
    this.getFilesGoogleDrive = function(userData, projectId, socket, callback) {
        var folderId = userData.PROJECTS[projectId].STORAGE_DETAILS.GOOGLE_DRIVE.FOLDER_ID;

        this.refreshToken(userData._id, projectId)
            .then(tokens => {
                oauth2Client.setCredentials(tokens);

                var drive = google.drive({
                    version: 'v3',
                    auth: oauth2Client
                });

                if(socket)
                    socket.emit('progressText', 'Authentication done. Iterating the files...');

                var pageToken = null;
                var files = new Array();

                _async.doWhilst(function(whilstCallback) {
                    drive.files.list({
                        q: "'" + folderId + "' in parents and trashed=false",
                        fields: 'nextPageToken, files(id, name, imageMediaMetadata)',
                        spaces: 'drive',
                        pageToken: pageToken
                    }, function(err, res) {
                        if (err)
                            whilstCallback(err)

                        else {
                            var data = res.data;
                            console.log(data);
                            console.log(files);
                            files = files.concat(data.files);
                            pageToken = data.nextPageToken;
                            console.log(files);
                            whilstCallback(null);
                        }
                    });
                }, function() {
                    return !!pageToken;
                }, function(err) {
                    if (err)
                        callback(err);

                    else
                        callback(null, files);
                });
            })
            .catch(err => callback(err))
    }

    this.getFileGoogleDrive = function(fileId, fileName, request, db) {
        var userData = request.auth.credentials.admin ? request.auth.credentials.admin : request.auth.credentials.user;
        var imageBuffer;

        var promise = new Promise((resolve, reject) => {
            _async.waterfall([
                function(callback) {
                    this.refreshToken(userData._id, request.query.projectId)
                        .then(tokens => callback(null, tokens))
                        .catch(err => callback(err));
                },
                function(tokens, callback) {
                    oauth2Client.setCredentials(tokens);

                    var drive = google.drive({
                        version: 'v2',
                        auth: oauth2Client
                    });

                    // console.log(request.query);

                    drive.files.get({
                        fileId: fileId,
                        alt: 'media'
                    }, {
                        responseType: 'arraybuffer',
                        encoding: null
                    }, function(err, response) {
                        if (err);
                        // callback(err);

                        else {
                            callback(null, response);
                        }
                    });
                },
                function(response, callback) {
                    var imageType = response.headers['content-type'];
                    if (imageType === 'application/dicom') {

                        var dicomData = {};
                        imageBuffer = response.data;
                        var options = {
                            method: 'POST',
                            url: config.get('AMIPOD_DICOM_API') + 'full_details',
                            headers: {
                                'Cache-Control': 'no-cache',
                                'content-type': 'multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW'
                            },
                            formData: {
                                file: {
                                    value: imageBuffer,
                                    options: {
                                        "filename": fileName,
                                        contentType: null
                                    }
                                }
                            }
                        };
                        requestsLib(options, function(error, response, body) {
                            if (error) {
                                // callback(error);
                                service.handleError(reject, error);
                            }
                            // console.log('res', response, 'err', error, 'body', body);
                            // console.log(body);
                            // dicomData.base64 = body.BASE64;
                            // console.log(body);
                            // console.log(res);
                            // body['type'] = 'dicomdata';
                            if (body !== undefined) {
                                callback(null, JSON.parse(body));
                            }
                            // console.log('bodytype', typeof(body));
                        });
                        // callback(null, dicomData);
                    } else
                        callback(null, response);
                },
                // ,function(body, callback){
                //     if(body['type'] === 'dicomdata'){
                //         var options =
                //             {
                //                 method: 'POST',
                //                 url: 'http://localhost:8010/api/DICOM/full_details',
                //                 headers:
                //                     {
                //                         'Cache-Control': 'no-cache',
                //                         'content-type': 'multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW'
                //                     },
                //                 formData:
                //                     {
                //                         file:
                //                             {
                //                                 value: imageBuffer,
                //                                 options:
                //                                     {
                //                                         "filename": fileName,
                //                                         contentType: null
                //                                     }
                //                             }
                //                     }
                //             };
                //         requestsLib(options, function (error, response, body) {
                //             if (error) callback(err);

                //             // console.log(body);
                //             var dicomData = {};
                //             console.log('adding rows and height');
                //             dicomData.width = body.COLUMNS;
                //             dicomData.height = body.ROWS;
                //             dicomData.base64 = body.BASE64;
                //             callback(null, dicomData);
                //         });
                //     }else
                //         callback(null, body);
                // }
                function(response, callback) {
                    var dimension, dataURI;

                    // console.log('response 381',response);

                    console.log('Dicom successful');

                    if (response.ACQUISITION_DATE || response['ACQUISITION_DATE']) {
                        dataURI = 'data:' + 'image/png' + ';base64,' + response.BASE64.substring(2, response.BASE64.length - 1);
                        dimension = {};
                        dimension.width = response.COLUMNS;
                        dimension.height = response.ROWS;
                        dimension.type = 'dicom';
                    } else {
                        var imageType = response.headers['content-type'];
                        var base64 = new Buffer(response.data, 'utf8').toString('base64');
                        dataURI = 'data:' + imageType + ';base64,' + base64;
                        dimension = sizeOf(response.data);
                    }

                    //     // var dimension = {};
                    //     // dimension.width = response.width;
                    //     // dimension.height = response.height;
                    //     // dimension.type = 'dicom'
                    //     // var dataURI = 'data:' + 'png' + ';base64,' + response.base64;

                    db.collection(config.get('IMAGES_COLLECTION')).update({
                        OBJECT_NAME: fileName,
                        USER_OID: new mongo.ObjectID(userData._id.toString())
                    }, {
                        $set: {
                            IMAGE_WIDTH: dimension.width,
                            IMAGE_HEIGHT: dimension.height,
                            IMAGE_MIME_TYPE: dimension.type,
                            IMAGE_CONTENT_LENGTH: dataURI.length
                        }
                    }, function(err, result) {
                        if (err)
                            callback(err);

                        else {
                            if (result.result.n > 0)
                                console.log('Image width height and MIME_TYPE updated.');

                            callback(null, dataURI);
                        }
                    });
                }
            ], function(err, result) {
                if (err)
                    service.handleError(reject, err);

                else {
                    // console.log(result);
                    resolve(result);
                }
            });
        });

        return promise;
    }

    this.checkToken = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            var id = request.auth.credentials.admin ? request.auth.credentials.admin._id : request.auth.credentials.user._id;

            this.refreshToken(id, request.payload.projectId)
                .then(tokens => resolve({
                    tokens
                }))
                .catch(err => service.handleError(reject, err));
        });

        return promise;
    }

    this.disconnectDriveHandler = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            var unsetQuery = 'PROJECTS.' + request.payload.projectId + '.STORAGE_DETAILS.GOOGLE_DRIVE';
            var query = {};
            query[unsetQuery] = '';

            console.log(unsetQuery);
            console.log(request.auth.credentials.user._id.toString());

            db.collection(config.get('USER_COLLECTION')).updateOne({
                _id: new mongo.ObjectID(request.auth.credentials.user._id.toString())
            }, {
                $unset: query
            }, function(err, result) {
                if (err)
                    service.handleError(reject, err)

                else {
                    console.log(result.result);
                    resolve('done');
                }
            })
        });

        return promise;
    }

    this.refreshToken = function(userId, projectId) {
        var promise = new Promise(function(resolve, reject) {

            db.collection(config.get('USER_COLLECTION')).findOne({
                _id: new mongo.ObjectID(userId)
            }, function(err, user) {
                if (err)
                    service.handleError(reject, err);

                else if (user) {
                    var tokens = user.PROJECTS[projectId].STORAGE_DETAILS.GOOGLE_DRIVE.tokens;

                    if (tokens == null || tokens.access_token == null) {
                        userSocket.emit('progressText', 'Authentication Failure...');
                        service.handleError(reject, err);
                    }

                    if (tokens.expiry_date < (new Date()).getTime()) {
                        console.log('Google Drive Access Token has expired');

                        oauth2Client.setCredentials({
                            refresh_token: tokens.refresh_token
                        });

                        oauth2Client.refreshAccessToken(function(err, newTokens) {
                            if (err)
                                service.handleError(reject, err);

                            else {
                                user.PROJECTS[projectId].STORAGE_DETAILS.GOOGLE_DRIVE.tokens = newTokens;

                                db.collection(config.get('USER_COLLECTION')).updateOne({
                                    _id: new mongo.ObjectID(user._id.toString())
                                }, {
                                    $set: {
                                        PROJECTS: user.PROJECTS
                                    }
                                }, function(err, result) {
                                    if (err)
                                        service.handleError(reject, err)

                                    else {
                                        console.log(result.result.n + ' records updated while updating token');

                                        resolve(newTokens);
                                    }
                                })
                            }
                        })
                    } else
                        resolve(tokens);
                }
            })
        })

        return promise;
    }

    return this;
}
