module.exports = function(service) {
    var config = require('../config/config')();
    var randomstring = require('randomstring');
    var uuid = require('uuid/v1');
    var _async = require('async');
    var mongo = require('mongodb');
    var crypto = require('crypto-js');
    var db = config.getDB();

    this.signUpHandler = function(request, h) {

        var promise = new Promise((resolve, reject) => {
            var currentDate = new Date().getTime();
            var newUser = {
                EMAIL_ID: request.payload.email.toLowerCase(),
                PASSWORD: service.generateHash(request.payload.password),
                NAME: request.payload.name,
                VERIFIED: false,
                USER_TYPE: request.payload.type,
                IS_MARKETING_ENABLE: true,
                ACCOUNT_CREATED_ON: currentDate,
                SESSION_COUNT: 0,
                STATUS: 'ENABLED',
                PROJECTS: {
                    DEFAULT: {
                        NAME: 'Default',
                        DATE_CREATED: currentDate,
                        ACTIVE_STORAGE: config.get('DEFAULT_STORAGE'),
                        EXPORT_TOKEN: uuid(),
                        STORAGE_DETAILS: {
                            [config.get('DEFAULT_STORAGE')]: config.get('DATA_MODEL').STORAGE_DATA[config.get('DEFAULT_STORAGE')]
                        },
                        STATUS: 'ACTIVE',
                        PROJECT_TYPE: config.get('DEFAULT_PROJECT_TYPE')
                    }
                },
                API_KEY: uuid()
            };

            console.log(newUser);

            _async.waterfall([
                function(callback) {
                    var email_split = request.payload.email.split('@');
                    domain_name = email_split[email_split.length - 1];

                    db.collection(config.get('UNIVERSITY_DOMAINS_COLLECTION')).aggregate([{
                        $match: {
                            "UNIVERSITY_DOMAINS": [domain_name]
                        }
                    }, {
                        $project: {
                            "_id": 1
                        }
                    }], function(err, success) {
                        if (err)
                            callback(err)
                        else {
                            console.log(success.length)
                            if (success.length > 0) { //STUDENT
                                console.log('student', request.payload.type);
                                if (request.payload.type === 'self') {
                                    newUser.USER_TYPE = config.get('USER_TYPE').STUDENT_SELF.NAME;
                                    newUser.SUBSCRIPTION_FLAG = config.get('USER_TYPE').STUDENT_SELF.SUBSCRIPTION_FLAG;
                                } else if (request.payload.type === 'admin') {
                                    newUser.USER_TYPE = config.get('USER_TYPE').STUDENT_ADMIN.NAME;
                                    newUser.SUBSCRIPTION_FLAG = config.get('USER_TYPE').STUDENT_ADMIN.SUBSCRIPTION_FLAG;
                                    newUser.TOTAL_SEATS_PURCHASED = config.get('USER_TYPE').STUDENT_ADMIN.SUBSCRIPTION_FLAG.LIMITS.SEAT_LIMIT;
                                    newUser.TOTAL_SEATS_USED = 0;
                                    newUser.PROJECTS.DEFAULT.TEAM_USERS = new Array();
                                }
                                newUser.UNIVERSITY_VERIFICATION = false;
                                newUser.UNIVERSITY_OID = new mongo.ObjectID(success[0]._id.toString());
                            } else { //PRO; NOT STUDENT
                                console.log('pro', request.payload.type);

                                if (request.payload.type === 'self') {
                                    newUser.USER_TYPE = config.get('USER_TYPE').SELF.NAME;
                                    newUser.SUBSCRIPTION_FLAG = config.get('USER_TYPE').SELF.SUBSCRIPTION_FLAG;
                                    newUser.PLAN_START_DATE = currentDate;
                                    newUser.PLAN_END_DATE = currentDate + config.get('USER_TYPE').SELF.TRIAL_PERIOD * 24 * 3600 * 1000;
                                } else if (request.payload.type === 'admin') {
                                    newUser.USER_TYPE = config.get('USER_TYPE').ADMIN.NAME;
                                    newUser.SUBSCRIPTION_FLAG = config.get('USER_TYPE').ADMIN.SUBSCRIPTION_FLAG;
                                    newUser.TOTAL_SEATS_PURCHASED = config.get('TOTAL_SEATS_PURCHASED');
                                    newUser.TOTAL_SEATS_USED = 0;
                                    newUser.PROJECTS.DEFAULT.TEAM_USERS = new Array();
                                    newUser.PLAN_START_DATE = currentDate;
                                    newUser.PLAN_END_DATE = currentDate + config.get('USER_TYPE').ADMIN.TRIAL_PERIOD * 24 * 3600 * 1000;
                                }
                            }
                            callback(null);
                        }
                    })
                },
                function(callback) {
                    // check if the user already exists
                    console.log('checking user exists')
                    db.collection(config.get('USER_COLLECTION')).findOne({
                        EMAIL_ID: request.payload.email.toLowerCase(),
                        USER_TYPE: request.payload.type
                    }, function(err, user) {
                        if (err) {
                            console.error(err);
                            callback('Error fetching the records');
                        } else if (user)
                            callback(request.payload.email + ' email is already taken.');

                        else if (request.payload.password != request.payload.confirmPassword)
                            callback('Your passwords do not match');

                        else
                            callback(null);
                    });
                },
                function(callback) {
                    var Url = require('url');
                    var permalink = request.payload.email.toLowerCase().replace(' ', '').replace(/[^\w\s]/gi, '').trim();
                    var verifyToken = randomstring.generate({
                        length: 64
                    });

                    newUser['VERIFY_TOKEN'] = verifyToken;
                    newUser['PERMALINK'] = permalink;

                    var referer = Url.parse(request.headers.referer);
                    var url = referer.protocol + '//' + referer.host;
                    console.log(referer);
                    var template_subs = {
                        verify_url: url + '/verify/' + request.payload.type + '/' + permalink + '/' + verifyToken,
                        username: request.payload.name
                    }

                    service.sendTemplateEmail(config.get('NEW_INVITE_EMAIL'), request.payload.email, config.get('EMAIL_ACCOUNT_ACTIVATION').SUBJECT, template_subs, config.get('EMAIL_ACCOUNT_ACTIVATION').TEMPLATE_ID, function(err, response) {
                        if (err)
                            callback(err);

                        else {
                            console.log('Verification email sent');
                            callback(null);
                        }
                    });
                },
                function(callback) {
                    var limits = (request.payload.type == config.get('USER_TYPE').STUDENT_ADMIN.NAME) ? config.get('USER_TYPE').STUDENT_ADMIN : config.get('USER_TYPE').STUDENT_SELF;

                    console.log(newUser)
                    db.collection(config.get('USER_COLLECTION')).insertOne(newUser, function(err, docsInserted) {
                        if (err)
                            callback(err);

                        else {
                            console.log('inserted');
                            callback(null);
                        }
                    });
                },
                function(callback) {
                    if (config.get('NOTIFY_NEW_REGISTERATION')) {
                        db.collection(config.get('USER_COLLECTION')).aggregate(
                            [{
                                    $group: {
                                        _id: '$USER_TYPE',
                                        COUNT: {
                                            $sum: 1
                                        }
                                    }
                                },
                                {
                                    $project: {
                                        _id: 0,
                                        USER_TYPE: '$_id',
                                        COUNT: '$COUNT'
                                    }
                                }
                            ],
                            function(err, count) {
                                if (err)
                                    console.error(err);

                                else {
                                    delete newUser.password;
                                    delete newUser.permalink;

                                    var totalUserCount = 0;

                                    count.forEach(function(item) {
                                        totalUserCount += item.COUNT;
                                    });

                                    var content = '<h2>Total Users : ' + totalUserCount + ' </h2><h2>Ocalvi Users : </h2><pre>' + JSON.stringify(count, null, 4) + '</pre><br /><pre>' + JSON.stringify(newUser, null, 4) + '</pre>';

                                    _async.each(config.get('ADMIN_EMAILS'), function(email, iterateCallback) {
                                        service.sendEmail(config.get('NEW_INVITE_EMAIL'), email, 'Yippiiee... New User Registeration', content, function(err, response) {
                                            err ? iterateCallback(err) : iterateCallback(null);
                                        });
                                    }, function(err) {
                                        err ? callback(err) : callback(null);
                                    });
                                }
                            });
                    } else
                        callback(null);
                }
            ], function(err, result) {
                if (err)
                    service.handleError(reject, err);

                else
                    resolve({
                        message: 'done'
                    });
            });
        });

        return promise;
    }

    this.getPlanPrice = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            var plans = JSON.parse(JSON.stringify(config.get('PAYMENT_PLANS')));

            resolve(plans);
        });

        return promise;
    }

    this.verifyHandler = function(request, h) {
        var promise = new Promise((resolve, reject) => {

            var body = request.payload;
            console.log(body)
            _async.waterfall([
                function(callback) {
                    db.collection(config.get('USER_COLLECTION')).findOne({
                        PERMALINK: body.permalink,
                        USER_TYPE: body.userType
                    }, function(err, user) {
                        if (err) {
                            console.error(err);
                            callback('Error while fetching user details');
                        } else if (user) {
                            if (user.VERIFIED)
                                callback(user.EMAIL_ID + ' is already verified.');

                            else if (user.VERIFY_TOKEN == body.verifyToken) {
                                console.log('This token is correct! Verify the user');

                                callback(null);
                            } else {
                                console.log('Token received', body.verifyToken);
                                console.log('Token should be :', user.VERIFY_TOKEN);

                                callback('The token is wrong! Verification rejected.');
                            }
                        } else {
                            console.log('Already verified!');
                            callback('Already verified!');
                        }
                    });
                },
                function(callback) {
                    const successfn = function(err, resp) {
                        if (err) {
                            console.error(err);
                            callback('Error while verifying the user.');
                        } else {
                            console.log('The user has been verified!');

                            callback(null);
                        }
                    };
                    if (body.userType === config.get('USER_TYPE').STUDENT_SELF.NAME || body.userType === config.get('USER_TYPE').STUDENT_ADMIN.NAME) {
                        db.collection(config.get('USER_COLLECTION')).update({
                            PERMALINK: body.permalink
                        }, {
                            $set: {
                                VERIFIED: true,
                                UNIVERSITY_VERIFICATION: true
                            },
                            $unset: {
                                VERIFY_TOKEN: '',
                                PERMALINK: ''
                            }
                        }, successfn)
                    }
                    db.collection(config.get('USER_COLLECTION')).update({
                        PERMALINK: body.permalink
                    }, {
                        $set: {
                            VERIFIED: true
                        },
                        $unset: {
                            VERIFY_TOKEN: '',
                            PERMALINK: ''
                        }
                    }, successfn);
                }
            ], function(err) {
                if (err)
                    service.handleError(reject, err);

                else
                    resolve({
                        message: 'done'
                    });
            });
        });

        return promise;
    }

    this.freelancerSignup = function(request, h) {
        return new Promise((resolve, reject) => {
            var newUser = {
                EMAIL_ID: request.payload.email.toLowerCase(),
                PASSWORD: service.generateHash(request.payload.password),
                NAME: request.payload.name,
                VERIFIED: false,
                USER_TYPE: config.get('USER_TYPE').FREELANCER.NAME,
                IS_MARKETING_ENABLE: true,
                CERT_LEVEL: 0,
                CHECKPOINT_PASSED: 0,
                SESSION_COUNT: 0,
                BASIC_TRAINING_COMPLETED: false,
                ERROR_FREE_PERCENTAGE: 100,
                ON_TIME_COMPLETION_PERCENTAGE: 100
            };

            _async.waterfall([
                function(callback) {
                    // check if the user already exists
                    db.collection(config.get('USER_COLLECTION')).findOne({
                        EMAIL_ID: request.payload.email.toLowerCase(),
                        USER_TYPE: config.get('USER_TYPE').FREELANCER.NAME
                    }, function(err, user) {
                        if (err) {
                            console.error(err);
                            callback('Error fetching the records');
                        } else if (user)
                            callback(request.payload.email + ' email is already taken.');

                        else if (request.payload.password != request.payload.confirmPassword)
                            callback('Your passwords do not match');

                        else
                            callback(null);
                    });
                },
                function(callback) {
                    if (config.get('NOTIFY_NEW_REGISTERATION')) {
                        db.collection(config.get('USER_COLLECTION')).aggregate([{
                            $group: {
                                _id: '$USER_TYPE',
                                COUNT: {
                                    $sum: 1
                                }
                            }
                        }, {
                            $project: {
                                _id: 0,
                                USER_TYPE: '$_id',
                                COUNT: '$COUNT'
                            }
                        }], function(err, count) {
                            if (err)
                                console.error(err);

                            else {
                                delete newUser.password;
                                delete newUser.permalink;

                                var totalUserCount = 0;

                                count.forEach(function(item) {
                                    totalUserCount += item.COUNT;
                                });

                                var content = '<h2>Total Users : ' + totalUserCount + ' </h2><h2>Ocalvi Users : </h2><pre>' + JSON.stringify(count, null, 4) + '</pre><br /><pre>' + JSON.stringify(newUser, null, 4) + '</pre>';

                                _async.each(config.get('ADMIN_EMAILS'), function(email, iterateCallback) {
                                    service.sendEmail(config.get('NEW_INVITE_EMAIL'), email, 'Yippiiee... New User Registeration', content, function(err, response) {
                                        err ? iterateCallback(err) : iterateCallback(null);
                                    });
                                }, function(err) {
                                    err ? callback(err) : callback(null);
                                });
                            }
                        });
                    } else
                        callback(null);
                },
                function(callback) {
                    var Url = require('url');
                    var permalink = request.payload.email.toLowerCase().replace(' ', '').replace(/[^\w\s]/gi, '').trim();
                    var verifyToken = randomstring.generate({
                        length: 64
                    });

                    newUser['VERIFY_TOKEN'] = verifyToken;
                    newUser['PERMALINK'] = permalink;

                    var referer = Url.parse(request.headers.referer);
                    var url = referer.protocol + '//' + referer.host;

                    var template_subs = {
                        verify_url: url + '/verify/' + config.get('USER_TYPE').FREELANCER.NAME + '/' + permalink + '/' + verifyToken,
                        username: request.payload.name
                    }

                    service.sendTemplateEmail(config.get('NEW_INVITE_EMAIL'), request.payload.email, config.get('EMAIL_ACCOUNT_ACTIVATION')['SUBJECT'], template_subs, config.get('EMAIL_ACCOUNT_ACTIVATION')['TEMPLATE_ID'], function(err, response) {
                        if (err)
                            callback(err);

                        else {
                            console.log('Verification email sent');
                            callback(null);
                        }
                    });
                },
                function(callback) {
                    db.collection(config.get('USER_COLLECTION')).insertOne(newUser, function(err, docsInserted) {
                        if (err)
                            callback(err);

                        else
                            callback(null);
                    });
                },
            ], function(err, result) {
                if (err)
                    service.handleError(reject, err);

                else
                    resolve({
                        message: 'done'
                    });
            });
        });
    }

    return this;
}
