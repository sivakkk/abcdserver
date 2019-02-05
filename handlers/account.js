module.exports = function(service, gfs) {
    var config = require('../config/config')();
    var randomstring = require('randomstring');
    var uuid = require('uuid/v1');
    var _async = require('async');
    var _request = require('request');
    var useragent = require('useragent');
    var mongo = require('mongodb');
    var fs = require('fs');
    var db = config.getDB();

    this.logoutHandler = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            db.collection(config.get('USER_COLLECTION')).updateOne({
                _id: new mongo.ObjectID(request.auth.credentials.user._id.toString())
            }, {
                $set: {
                    LAST_LOGGED_OUT: (new Date()).getTime()
                },
                $unset: {
                    AUTH_TOKEN: 1
                }
            }, function(err, res) {
                if (err)
                    service.handleError(reject, err, 'Error while fetching the records.');

                else {
                    console.log(request.auth.credentials.user.EMAIL_ID, ' has been logged out');
                    console.log(res.result.nModified, 'records updated');

                    request.cookieAuth.clear();
                    request.auth.isAuthenticated = false;


                    console.log(request.auth);

                    resolve({
                        msg: "done"
                    });
                }
            });
        });

        return promise;
    }

    this.me = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            var user = request.auth.credentials.user;

            delete user.PASSWORD;

            resolve(user);
        });

        return promise;
    }

    this.uploadAvatar = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            var data = request.payload.avatar;

            var file = data['hapi'];

            var writeStream = gfs.createWriteStream({
                filename: file.filename,
                mode: 'w'
            });

            writeStream.on('close', function(file) {
                saveUser(request, {
                    USER_AVATAR: file._id
                }).then((data) => {

                    //retrive image
                    resolve({
                        'avatar_id': file._id
                    });

                }).catch((err) => {
                    service.handleError(reject, err, 'Error while saving the avatar.');
                });
            });

            data.pipe(writeStream);
        });

        return promise;
    }

    this.updateName = function(request, h){
        var promise = new Promise((resolve,reject) => {
            console.log(request.payload);
            const name = request.payload.name;
            console.log('Updating Name');
            if(name != ''){
                db.collection(config.get('USER_COLLECTION')).findOne({
                    _id: mongo.ObjectId(request.auth.credentials.user._id)
                }, function(err, user){
                    if (err) {
                        console.log("error + " + err);
                        service.handleError(reject, err);
                    } else if (!user) {
                        service.handleError(reject, 'No user found.');
                    } else if(user){
                        saveUser(request, {NAME: name}).then(data=>{
                            resolve({ msg: "Done", NAME: name });
                        }).catch((err) => {
                            service.handleError(reject, err);
                        })
                    }
                })
            }
            else{
                service.handleError(reject, 'No name received!');
            }
        });
        return promise;
    }

    this.saveUser = function(request, dataObject) {
        var promise = new Promise((resolve, reject) => {
            db.collection(config.get('USER_COLLECTION')).updateOne({
                    _id: new mongo.ObjectID(request.auth.credentials.user._id.toString())
                }, {
                    $set: dataObject
                },
                function(err) {
                    if (err)
                        service.handleError(reject, err, 'Error while saving the records.');

                    else
                        resolve('done');
                });
        });

        return promise;
    }

    this.getUserAvatar = async function(request, reply) {

        var promise = new Promise((resolve, reject) => {
            try {
                var _imageId = request.params._imageid;

                gfs.findOne({
                    _id: _imageId
                }, function(err, file) {
                    if (err)
                        service.handleError(reject, err, 'Error while getting the avatar.');

                    else if (file)
                        resolve(gfs.createReadStream({ filename: file.filename }));

                    else
                        service.handleError(reject, 'No file was found for getUserAvatar');
                });
            } catch (e) {
                service.handleError(reject, e, 'Error while getting the avatar.');
            }
        });

        return promise;
    }

    this.connectUs = function(request, h) {

        var promise = new Promise((resolve, reject) => {
            var auth = 'Basic ' + new Buffer('any:' + config.get('MAILCHIMP_API_KEY')).toString('base64');
            var data = {
                email_address: request.payload.email,
                status: 'subscribed'
            };

            _async.parallel([
                function(callback) {

                    var content = 'oclavi contact <br>' +
                        'name : ' + request.payload.name + '<br>' +
                        'subject : ' + request.payload.subject + '<br>' +
                        'mobile : ' + request.payload.mobile + '<br>' +
                        'message : ' + request.payload.message + '<br>' +
                        'email_address : ' + request.payload.email;

                    service.sendEmail('admin@carabinertech.com', 'info@carabinertech.com', 'Contact oclavi', content, function(err, response) {
                        if (err) {
                            callback(err);
                        } else {
                            callback(null, response);
                        }
                    });
                },
                function(callback) {
                    var url = 'https://' + config.get('MAILCHIMP_INS_ID') + '.api.mailchimp.com/3.0/lists/' + config.get('MAILCHIMP_LIST_ID') + '/members/';

                    _request({
                        method: 'POST',
                        url: url,
                        headers: {
                            'content-type': 'application/json'
                        },
                        body: JSON.stringify(data),
                        headers: {
                            "Authorization": auth
                        }
                    },
                    function(error, response, body) {
                        error ? callback(error) : callback(null);
                    });
                }
            ], function(err) {
                if (err)
                    service.handleError(reject, err, 'We have faced some issue while sending your message.');

                else
                    resolve({
                        message: 'done',
                    });
            });

        });

        return promise;
    }

    this.confirmPasswordHandler = function(request, h) {
        var bcrypt = require('bcrypt-nodejs');

        var promise = new Promise((resolve, reject) => {
            var query = {
                _id : new mongo.ObjectID(request.auth.credentials.user._id)
            };

            if (request.auth.credentials.user.USER_TYPE == config.get('USER_TYPE').ADMIN.NAME) {
                query['$or'] = [{
                    USER_TYPE: config.get('USER_TYPE').ADMIN.NAME
                }, {
                    USER_TYPE: config.get('USER_TYPE').STUDENT_ADMIN.NAME
                }];
            } else if (request.auth.credentials.user.USER_TYPE == config.get('USER_TYPE').SELF.NAME) {
                query['$or'] = [{
                    USER_TYPE: config.get('USER_TYPE').SELF.NAME
                }, {
                    USER_TYPE: config.get('USER_TYPE').STUDENT_SELF.NAME
                }];
            }

            db.collection(config.get('USER_COLLECTION')).findOne(query, function(err, user) {
                if (err)
                    service.handleError(reject, err);

                else if (!user || !bcrypt.compareSync(request.payload.password, user.PASSWORD))
                    resolve({ passwordMatch: false });

                else
                    resolve({ passwordMatch: true });
            });
        });

        return promise;
    }
    this.accountSwitch = function(request, reply){
        var promise = new Promise((resolve, reject) => {
            console.log("payload : ", request.payload.USER_TYPE);
            _async.waterfall([
                function (callback) {
                    if (request.payload.USER_TYPE == config.get('USER_TYPE').STUDENT_SELF.NAME) {
                        console.log("Swtiching user from student-self to student-admin")
                        db.collection(config.get('USER_COLLECTION')).count({
                            ADMIN_ID: new mongo.ObjectID(request.payload._id)
                        }, function (err, team_count) {
                            if (err) {
                                callback(err); //service.handleError(reject, err);
                            }
                            else {
                                db.collection(config.get('USER_COLLECTION')).updateOne({
                                    _id: new mongo.ObjectID(request.payload._id)
                                }, {
                                    $set: {
                                        USER_TYPE: config.get('USER_TYPE').STUDENT_ADMIN.NAME,
                                        TOTAL_SEATS_PURCHASED: config.get('USER_TYPE').STUDENT_ADMIN.SUBSCRIPTION_FLAG.LIMITS.SEAT_LIMIT,
                                        TOTAL_SEATS_USED: team_count,
                                        "SUBSCRIPTION_FLAG.LIMITS.SEAT_LIMIT": config.get('USER_TYPE').STUDENT_ADMIN.SUBSCRIPTION_FLAG.LIMITS.SEAT_LIMIT,
                                    }
                                }, function (err, res) {
                                    if (err) {
                                        callback(err); // service.handleError(reject, err);
                                    } else {
                                        console.log("UPDATED USER_TYPE", res.USER_TYPE)
                                        if (team_count > 0) {
                                            db.collection(config.get('USER_COLLECTION')).update({
                                                ADMIN_ID: new mongo.ObjectID(request.payload._id)
                                            }, {
                                                $set: {
                                                    MIGRATION: false,
                                                }
                                            }, {
                                                multi: true
                                            }, function (err, res) {
                                                if (err) {
                                                    callback(err); //service.handleError(reject, err);
                                                } else {
                                                    callback(res);
                                                }
                                            });

                                        }
                                        callback(res);
                                    }
                                });
                            }
                        });
                    } else if (request.payload.USER_TYPE == config.get('USER_TYPE').STUDENT_ADMIN.NAME) {
                        // Switching user from Student-admin to Student-self
                        console.log("Swtiching user from student-admin to student-self")
                        db.collection(config.get('USER_COLLECTION')).count({
                            ADMIN_ID: new mongo.ObjectID(request.payload._id)
                        }, function (err, team_count) {
                            if (err) {
                                callback(err);// service.handleError(reject, err);
                            } else {
                                if (team_count > 0) {
                                    db.collection(config.get('USER_COLLECTION')).update({
                                        ADMIN_ID: new mongo.ObjectID(request.payload._id)
                                    }, {
                                        $set: {
                                            MIGRATION: true,
                                        }
                                    }, {
                                        multi: true
                                    }, function (err, res) {
                                        if (err) {
                                            callback(err);// service.handleError(reject, err);
                                        } else {
                                            callback(res);
                                        }
                                    });
                                }
                                db.collection(config.get('USER_COLLECTION')).updateOne({
                                    _id: new mongo.ObjectID(request.payload._id)
                                }, {
                                    $set: {
                                        USER_TYPE: config.get('USER_TYPE').STUDENT_SELF.NAME,
                                        "SUBSCRIPTION_FLAG.LIMITS.SEAT_LIMIT": config.get('USER_TYPE').STUDENT_SELF.SUBSCRIPTION_FLAG.LIMITS.SEAT_LIMIT
                                    },
                                    $unset: {
                                        TOTAL_SEATS_PURCHASED: "",
                                        TOTAL_SEATS_USED: "'"
                                    }
                                }, function (err, res) {
                                    if (err) {
                                        callback(err);// service.handleError(reject, err);
                                    } else {
                                        callback(res);
                                    }
                                });
                            }
                        });
                    }
                }
            ])
        });
        return promise;
    }


    //////////////////////////////////Downgrade of Account/////////////////////////////////
    this.accountDowngrade = function(request, reply){
        var promise = new Promise((resolve, reject) => {
            /////////////////////////////Self to Student-self/////////////////////////////////////
            try {
                if (request.payload.USER_TYPE == config.get('USER_TYPE').SELF.NAME) {
                    console.log("Switching user from Self to Student_self ");
                    console.log("payload : ",request.payload);

                    db.collection(config.get('USER_COLLECTION')).update({
                            _id: new mongo.ObjectID(request.payload._id)
                        }, {
                            $set: {
                                USER_TYPE: config.get('USER_TYPE').STUDENT_SELF.NAME,
                                'SUBSCRIPTION_FLAG.LIMITS.IMAGE_LIMIT': config.get('USER_TYPE').STUDENT_SELF.SUBSCRIPTION_FLAG.LIMITS.IMAGE_LIMIT,
                            }
                        },
                        function (err,res) {
                            if (err)
                                service.handleError(reject, err);
                            else
                                resolve(res);
                        });
                }
                /////////////////////Admin to Student_admin///////////////////////////////////////
                else if (request.payload.USER_TYPE  == config.get('USER_TYPE').ADMIN.NAME) {
                    console.log("Swtiching user from ADMIN to STUDENT-ADMIN");
                    db.collection(config.get('USER_COLLECTION')).count({
                        ADMIN_ID: new mongo.ObjectID(request.payload._id)
                    }, function(err, team_count) {
                        if (err) {
                            service.handleError(reject, err);
                        }
                        else if (team_count > config.get('USER_TYPE').STUDENT_ADMIN.SUBSCRIPTION_FLAG.LIMITS.SEAT_LIMIT) {
                            service.handleError(reject, 'PLEASE REMOVE INVITED USER');
                        }
                        else {
                            db.collection(config.get('USER_COLLECTION')).updateOne({
                                _id: new mongo.ObjectID(request.payload._id)
                            }, {
                                $set: {
                                    USER_TYPE: config.get('USER_TYPE').STUDENT_ADMIN.NAME,
                                    'SUBSCRIPTION_FLAG.LIMITS.IMAGE_LIMIT': config.get('USER_TYPE').STUDENT_ADMIN.SUBSCRIPTION_FLAG.LIMITS.IMAGE_LIMIT,
                                    TOTAL_SEATS_PURCHASED: config.get('USER_TYPE').STUDENT_ADMIN.SUBSCRIPTION_FLAG.LIMITS.SEAT_LIMIT,
                                    TOTAL_SEATS_USED: team_count,
                                }
                            }, function (err, res) {
                                if (err) {
                                    service.handleError(reject, err);
                                } else {
                                    resolve(res);
                                }
                            });
                        }
                    });
                }
            }
            catch (e) {
                service.handleError(reject, e);
            }
        });
        return promise;
    }

    //delete Account
    this.deleteAccount = function(request, reply) {
        //  var password = request.payload.password;
        var promise = new Promise((resolve, reject) => {
            _async.waterfall([
                /*function (callback) {
                    service.sendTemplateEmail(config.get('NEW_INVITE_EMAIL'), request.payload.email, config.get('EMAIL_DELETE_WARNING')['SUBJECT'], config.get('EMAIL_DELETE_WARNING')['TEMPLATE_ID'], function (err, response) {
                        if (err)
                        {
                            console.log('error');
                            callback(err);
                        }
                        else {
                            console.log('Account deletition email has been sent.');
                            callback(null);
                        }
                    });
                },*/
                function (callback) {
                    console.log("Delete Account", request.payload);
                    if ((request.payload.USER_TYPE == config.get('USER_TYPE').STUDENT_SELF.NAME) || (request.payload.USER_TYPE == config.get('USER_TYPE').SELF.NAME)) {
                        db.collection(config.get('USER_COLLECTION')).update({
                            _id: new mongo.ObjectID(request.payload._id)
                        }, {
                            $set: {
                                DELETED: true,
                                DELETED_DATE_TIME: new Date().getTime()
                            }
                        }, function (err, res) {
                            if (err) {
                                callback(err)//service.handleError(reject, err);
                            } else {
                                console.log("Response here : ..........");
                                callback(res);
                            }
                        });
                    }
                    else if ((request.payload.USER_TYPE == config.get('USER_TYPE').STUDENT_ADMIN.NAME) || (request.payload.USER_TYPE == config.get('USER_TYPE').ADMIN.NAME)) {
                        db.collection(config.get('USER_COLLECTION')).update({
                            $or: [
                                {ADMIN_ID: new mongo.ObjectID(request.payload._id)}, {_id: new mongo.ObjectID(request.payload._id)}]
                        }, {
                            $set: {
                                DELETED: true,
                                DELETED_DATE_TIME: new Date().getTime()
                            }
                        }, {
                            multi: true
                        }, function (err, res) {
                            if (err) {
                                service.handleError(reject, err);
                            } else {
                                resolve(res);
                            }
                        });
                    }
                }
            ],function (err) {
                if (err)
                    console.error(err);
                resolve({
                    message: 'done'
                });
            });
        });
        return promise;
    }

    this.savePhoneNumber = function (request, h) {
        var promise = new Promise((resolve, reject) => {
            if (!request.payload.phone_number) {
                service.handleError(reject, 'Phone number is missing');
                return;
            }

            db.collection(config.get('USER_COLLECTION')).updateOne({
                _id : new mongo.ObjectID(request.auth.credentials.user._id.toString())
            }, {
                $set: {
                    PHONE_NUMBER : request.payload.phone_number
                }
            }, function(err, result) {
                if(err)
                    service.handleError(reject, err)

                else{
                    console.log(result.result.n + ' records updated while saving phone number');

                    resolve('done');
                }
            })
        });

        return promise;
    }


    this.regenerateAPI_key = function (request, h) {
        var promise = new Promise((resolve, reject) => {
            console.log('Regenrating API key for ' + request.auth.credentials.user._id);
            var newAPI_KEY = uuid();

            db.collection(config.get('USER_COLLECTION')).updateOne({
                _id : new mongo.ObjectID(request.auth.credentials.user._id.toString())
            }, {
                $set: {
                    API_KEY : newAPI_KEY
                }
            }, function(err, result) {
                if(err)
                    service.handleError(reject, err)

                else{
                    console.log(result.result.n + ' records updated while regenrating API key');

                    resolve({msg:'done', API_KEY: newAPI_KEY});
                }
            })
        });

        return promise;
    }

    return this;
}
