module.exports = function(service) {
    var config = require('../config/config')();
    var randomstring = require('randomstring');
    var uuid = require('uuid/v1');
    var _async = require('async');
    var mongo = require('mongodb');
    var bcrypt = require('bcrypt-nodejs');
    var db = config.getDB();
    var _this = this;

    this.loginHandler = function(request, h) {
        //first query for user then query for corresponding admin
        var promise = new Promise((resolve, reject) => {
            console.log(request.payload.email + ' trying to log in');

            var rememberMe = request.payload.rememberMe || false;

            if (request.auth.isAuthenticated) {
                console.log('Already Authenticated');

                db.collection(config.get('WORKING_IMAGES_COLLECTION')).findOne({
                    USER_OID: new mongo.ObjectID(request.auth.credentials.user._id.toString())
                }, function(err, obj) {
                    if (err)
                        service.handleError(reject, err);

                    else if (!obj) {
                        console.log('No working image for this user.');
                        console.log('Logging out this user.');

                        request.cookieAuth.clear();
                        request.auth.isAuthenticated = false;

                        _this.loginHandler(request).then((data) => {
                            resolve(data);
                        }, (err) => {
                            service.handleError(reject, err);
                        });
                    } else
                        resolve({
                            redirect: '/classify/' + obj.OBJECT_OID.toString(),
                            data: obj.LABEL_DETAILS
                        });
                });
            } else {
                console.log(request.payload.email, request.payload.type);

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
                }

                console.log(query);
                var currentDate = new Date();

                db.collection(config.get('USER_COLLECTION')).findOne(query, function(err, user) {
                    if (err)
                        service.handleError(reject, err);

                    else if (!user || !bcrypt.compareSync(request.payload.password, user.PASSWORD))
                        service.handleError(reject, 'Incorrect username, password or user type', 400);

                    else if (!user.VERIFIED) {
                        resolve({
                            user: user,
                            redirect: '/verify-email'
                        });
                    }

                    else {
                        var sid = uuid();
                        var last_login = new Date().getTime();

                        _async.parallel([
                            function(callback) {
                                db.collection(config.get('USER_COLLECTION')).updateOne(query, {
                                    $set: {
                                        AUTH_TOKEN: sid,
                                        LAST_LOGGED_IN: last_login,
                                        LAST_LOGGED_IN_IP: request.payload.ipDetails.ip
                                    },
                                    $inc : {
                                        SESSION_COUNT : 1
                                    }
                                }, function(err, res) {
                                    if (err)
                                        callback(err);

                                    else {
                                        console.log('AUTH_TOKEN updated for ' + res.result.n + ' records.');
                                        callback(null);
                                    }
                                });
                            },
                            function(callback) {
                                db.collection(config.get('USER_IP_LOGS_COLLECTION')).insertOne({
                                    USER_OID: new mongo.ObjectId(user._id),
                                    IP_DETAILS: request.payload.ipDetails,
                                    LAST_LOGGED_IN: last_login
                                }, function(err, res) {
                                    if (err)
                                        callback(err);

                                    else {
                                        console.log('IP deatils saved for ' + user._id);
                                        callback(null);
                                    }
                                });
                            },
                            function(callback) {
                                if (user.USER_TYPE == config.get('USER_TYPE').TEAM.NAME) {
                                    db.collection(config.get('USER_COLLECTION')).findOne({
                                        _id: new mongo.ObjectID(user.ADMIN_ID)
                                    }, function(err, admin) {
                                        if (err)
                                            callback((typeof err == 'string') ? new Error(err) : err);

                                        else if (!admin)
                                            callback('No admin account associated.');

                                        else if (admin.USER_TYPE == config.get('USER_TYPE').ADMIN.NAME && admin.PLAN_END_DATE < (new Date()).getTime())
                                            callback('The plan has expired. Kindly contact your administrator.');

                                        else
                                            callback(null, admin);
                                    });
                                }

                                else
                                    callback(null);
                            }
                        ], function(err, results) {
                            if (err)
                                service.handleError(reject, err);

                            else {
                                var admin = results[2];
                                user.AUTH_TOKEN = sid;
                                user.LAST_LOGGED_IN = new Date().getTime();

                                let PROJECTS = user.PROJECTS, adminProjects;

                                delete user.PASSWORD;
                                delete user.PROJECTS;

                                if (admin) {
                                    adminProjects = admin.PROJECTS;
                                    delete admin.PASSWORD;
                                    delete admin.PROJECTS;
                                }

                                request.cookieAuth.set({
                                    sid,
                                    user,
                                    admin
                                });

                                request.auth.isAuthenticated = true;

                                request.server.app.cache.set(sid, {
                                    user,
                                    admin
                                }, 0);

                                if (rememberMe)
                                    request.cookieAuth.ttl(30 * 24 * 60 * 60 * 1000);
                                else
                                    request.cookieAuth.ttl(3 * 24 * 60 * 60 * 1000);

                                if (request.payload.type == config.get('USER_TYPE').ADMIN.NAME || request.payload.type == config.get('USER_TYPE').STUDENT_ADMIN.NAME) {
                                    resolve({
                                        user: user,
                                        redirect: '/profile'
                                    });
                                } else if (request.payload.type == config.get('USER_TYPE').TEAM.NAME) {
                                    user.PROJECTS = PROJECTS;

                                    if (!user.PROJECTS || user.PROJECTS.length === 0)
                                        service.handleError(reject, 'No projects found!');

                                    else
                                        resolve({ user: user, adminProjects: adminProjects, redirect: '/profile'});
                                } else if (request.payload.type == config.get('USER_TYPE').SELF.NAME || request.payload.type == config.get('USER_TYPE').STUDENT_SELF.NAME) {
                                    resolve({
                                        user: user,
                                        redirect: '/profile'
                                    });
                                } else if (request.payload.type == 'freelancer') {
                                    resolve({
                                        user: user,
                                        redirect: '/training'
                                    });
                                }
                            }
                        });
                    }
                });
            }
        });

        return promise;
    }

    this.freelancerLogin = function(request, h) {

        var promise = new Promise((resolve, reject) => {
            console.log(request.payload.email);
            var rememberMe = request.payload.rememberMe || false;

            var query = {
                EMAIL_ID: request.payload.email.toLowerCase(),
                USER_TYPE: config.get('USER_TYPE').FREELANCER.NAME
            };

            db.collection(config.get('USER_COLLECTION')).findOne(query, function(err, user) {
                if (err)
                    service.handleError(reject, err);

                else if (!user || !bcrypt.compareSync(request.payload.password, user.PASSWORD))
                    service.handleError(reject, 'Incorrect username, password or user type', 400);

                else if (!user.VERIFIED) {
                    resolve({
                        user: user,
                        redirect: '/verify-email'
                    });
                } else {
                    var sid = uuid();

                    _async.parallel([
                        function(callback) {
                            db.collection(config.get('USER_COLLECTION')).updateOne({
                                _id: user._id
                            }, {
                                $set: {
                                    AUTH_TOKEN: sid,
                                    LAST_LOGGED_IN: new Date().getTime()
                                },
                                $inc : {
                                    SESSION_COUNT : 1
                                }
                            }, function(err) {
                                if (err)
                                    callback(err);

                                else
                                    callback(null);
                            });
                        },
                        function(callback) {
                            if (user.USER_TYPE == config.get('USER_TYPE').FREELANCER.NAME && user.ADMIN_ID) {
                                db.collection(config.get('USER_COLLECTION')).findOne({
                                    _id: new mongo.ObjectID(user.ADMIN_ID)
                                }, function(err, admin) {
                                    if (err)
                                        callback(err);

                                    else if (!admin)
                                        callback('No admin account associated.');

                                    else if (admin.FAILED_PAYMENT)
                                        callback('There\'s is a pending failed payment for this account. Kindly contact your administrator.');

                                    else
                                        callback(null, admin);
                                });
                            } else if (user.FAILED_PAYMENT)
                                callback('There\'s is a pending failed payment for this account. Please clear that before login in.');

                            else
                                callback(null);
                        }
                    ], function(err, results) {
                        if (err)
                            service.handleError(reject, err);

                        else {
                            var admin = results[1];
                            user.AUTH_TOKEN = sid;
                            user.LAST_LOGGED_IN = new Date().getTime();

                            delete user.PASSWORD;
                            delete user.PROJECTS;

                            if (admin) {
                                delete admin.PASSWORD;
                                delete admin.PROJECTS;
                            }

                            console.log("setting ttl");
                            // request.cookieAuth.ttl(12*24*60*60*1000);
                            request.cookieAuth.set({
                                sid,
                                user,
                                admin
                            });

                            request.auth.isAuthenticated = true;


                            request.server.app.cache.set(sid, {
                                user,
                                admin
                            }, 0);

                            if (rememberMe)
                                request.cookieAuth.ttl(30 * 24 * 60 * 60 * 1000);
                            else
                                request.cookieAuth.ttl(3 * 24 * 60 * 60 * 1000);


                            console.log('freelancer', request.payload);
                            console.log(user);

                            if (user.BASIC_TRAINING_COMPLETED)
                                resolve({
                                    user: user,
                                    redirect: '/freelancer/profile'
                                });

                            else
                                resolve({
                                    user: user,
                                    redirect: '/freelancer/training'
                                });

                        }
                    });
                }
            });

        });

        return promise;
    }

    return this;
}
