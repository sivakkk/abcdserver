module.exports = function(service) {
    var config = require('../config/config')();
    var randomstring = require('randomstring');
    var _async = require('async');
    var fs = require('fs');
    var mongo = require('mongodb');
    var bcrypt = require('bcrypt-nodejs');
    var db = config.getDB();

    this.forgetPassword = function(request, h) {

        var promise = new Promise((resolve, reject) => {

            var query = {
                EMAIL_ID: request.payload.email.toLowerCase()
            };

            if (request.payload.type == config.get('USER_TYPE').ADMIN.NAME) {
                query['$or'] = [{
                    USER_TYPE: config.get('USER_TYPE').ADMIN.NAME
                }, {
                    USER_TYPE: config.get('USER_TYPE').STUDENT_ADMIN.NAME
                }];
            } else if (request.payload.type == config.get('USER_TYPE').SELF.NAME) {
                query['$or'] = [{
                    USER_TYPE: config.get('USER_TYPE').SELF.NAME
                }, {
                    USER_TYPE: config.get('USER_TYPE').STUDENT_SELF.NAME
                }];
            } else if (request.payload.type == config.get('USER_TYPE').TEAM.NAME) {
                query['$and'] = [{
                    USER_TYPE: config.get('USER_TYPE').TEAM.NAME
                }];
            } else if (request.payload.type == config.get('USER_TYPE').FREELANCER.NAME) {
                query['$and'] = [{
                    USER_TYPE: config.get('USER_TYPE').FREELANCER.NAME
                }];
            }

            _async.waterfall([
                function(callback) {
                    var token = randomstring.generate({
                        length: 64
                    });
                    callback(null, token);
                },

                function(token, callback) {
                    // check if the user already exists
                    db.collection(config.get('USER_COLLECTION')).findOne(query, function(err, user) {
                        if (err) {
                            console.error(err);
                            callback('Internal server error');
                        }

                        else if (user)
                            callback(null, token);

                        else
                            callback('Email address is not registered');
                    });
                },

                function(token, callback) {

                    var expire = Date.now() + 3600000 * 24;;
                    db.collection(config.get('USER_COLLECTION')).updateOne(query, {
                        $set: {
                            RESET_PASSWORD_TOKEN: token,
                            RESET_PASSWORD_EXPIRE: expire
                        }
                    }, function(err) {
                        if (err)
                            callback(err);
                        else
                            callback(null, token);
                    });
                },
                function(token, callback) {
                    const url = request.headers.origin + '/reset-password/' + token;

                    var template_subs = {
                        reset_url: url,
                        useremail: request.payload.email
                    }

                    service.sendTemplateEmail(config.get('NEW_INVITE_EMAIL'), request.payload.email, config.get('EMAIL_FORGOT_PASSWORD').SUBJECT, template_subs, config.get('EMAIL_FORGOT_PASSWORD').TEMPLATE_ID, function(err, response) {
                        if (err)
                            callback(err);

                        else {
                            console.log(response);
                            callback(null);
                        }
                    });
                }
            ], function(err, result) {
                if (err)
                    service.handleError(reject, err);

                else {
                    resolve({
                        "done": "ok"
                    });
                }
            })
        });

        return promise;
    }

    this.verifyPasswordToken = function(request, h) {

        return new Promise((resolve, reject) => {
            db.collection(config.get('USER_COLLECTION')).findOne({
                RESET_PASSWORD_TOKEN: request.payload.token
            }, function(err, user) {
                if (err)
                    service.handleError(reject, err);

                else if (user) {
                    if (user.RESET_PASSWORD_EXPIRE > Date.now()) {
                        resolve({
                            "done": "ok"
                        });
                    }

                    else
                        service.handleError(reject, 'Your reset password token has been expired. Please try it again');
                }

                else
                    service.handleError(reject, 'Your reset password token is invalid. Please try it again');
            });
        })
        return promise;
    }

    this.resetPassword = function(request, h) {
        console.log(request.payload);
        var promise = new Promise((resolve, reject) => {
            db.collection(config.get('USER_COLLECTION')).findOne({
                RESET_PASSWORD_TOKEN: request.payload.token
            }, function(err, user) {
                if (err)
                    service.handleError(reject, err);

                else if (user) {
                    if (user.RESET_PASSWORD_EXPIRE > Date.now()) {
                        db.collection(config.get('USER_COLLECTION')).updateOne({
                            RESET_PASSWORD_TOKEN: request.payload.token
                        }, {
                            $set: {
                                PASSWORD: service.generateHash(request.payload.password)
                            }
                        }, function(err) {
                            if (err)
                                service.handleError(reject, err);
                            if (user.USER_TYPE === 'freelancer')
                                resolve({
                                    redirect: "freelancer/login"
                                })
                            else
                                resolve({
                                    redirect: "login"
                                });
                        });
                    }

                    else
                        service.handleError(reject, 'Your reset password token has been expired. Please try it again');
                }

                else
                    service.handleError(reject, 'Your reset password token is invalid. Please try it again');
            });
        });

        return promise;
    }

    this.updatePassword = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            var curr = request.payload.oldPassword;

            db.collection(config.get('USER_COLLECTION')).findOne({
                _id: new mongo.ObjectID(request.auth.credentials.user._id.toString())
            }, function(err, user) {
                if (err)
                    service.handleError(reject, err);

                else if (!user)
                    service.handleError(reject, 'No user found.');

                else if (bcrypt.compareSync(curr, user.PASSWORD)) {
                    db.collection(config.get('USER_COLLECTION')).updateOne({
                        _id: new mongo.ObjectID(request.auth.credentials.user._id.toString())
                    }, {
                        $set : {
                            PASSWORD: service.generateHash(request.payload.newPassword)
                        }
                    }, function (err, result) {
                        if(err)
                            service.handleError(reject, err);

                        else if(result.result.n == 0)
                            service.handleError(reject, 'No records were changed while updating the password.');

                        else {
                            var content = 'Your password has been updated!';

                            service.sendEmail(config.get('NEW_INVITE_EMAIL'), request.auth.credentials.user.EMAIL_ID, 'Carabiner Account', content, function(err, response) {
                                if(err) {
                                    console.error(err);
                                    service.handleError(reject, 'Error while sending password change email.');
                                }

                                else {
                                    resolve({
                                        msg: "Done"
                                    });
                                }
                            });
                        }
                    });
                }

                else
                    service.handleError(reject, 'Your old password is incorrect');
            });
        });

        return promise;
    }

    return this;
}
