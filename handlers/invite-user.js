module.exports = function(service) {
    var config = require('../config/config')();
    var randomstring = require('randomstring');
    var _async = require('async');
    var mongo = require('mongodb');
    var crypto = require('crypto-js');
    var url = require('url');
    var fs = require('fs');
    var db = config.getDB();

    this.getInvitedUsersHandler = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            db.collection(config.get('USER_COLLECTION')).find({
                ADMIN_ID: new mongo.ObjectID(request.auth.credentials.user._id)
            }, {
                ADMIN_ID: 0,
                PASSWORD: 0,
                LAST_LOGGED_IN: 0,
                LAST_LOGGED_OUT: 0,
                AUTH_TOKEN: 0,
                USER_TYPE: 0
            }).toArray(function(err, docs) {
                if (err)
                    service.handleError(reject, err);

                else
                    resolve(docs);
            });
        });

        return promise;
    }

    this.sendInviteHandler = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            // if (request.auth.credentials.user.USER_TYPE == config.get('USER_TYPE').STUDENT_ADMIN.NAME || request.auth.credentials.user.USER_TYPE == config.get('USER_TYPE').STUDENT_SELF.NAME) {
            //     service.handleError(reject, 'You are not allowed to buy more seats');
            //     return;
            // } else if (request.auth.credentials.user.PLAN_END_DATE < (new Date()).getTime()) {
            //     service.handleError(reject, 'Your subscription has ended. Please upgrade');
            //     return;
            // }

            if (request.auth.credentials.user.PLAN_END_DATE < (new Date()).getTime()) {
                service.handleError(reject, 'Your subscription has ended. Please upgrade');
                return;
            }

            var body = JSON.parse(request.payload);

            if (request.auth.credentials.user.TOTAL_SEATS_USED >= request.auth.credentials.user.TOTAL_SEATS_PURCHASED) {
                service.handleError(reject, 'You have already used all your seats.');
                return;
            }

            db.collection(config.get('USER_COLLECTION')).findOne({
                EMAIL_ID: body.EMAIL_ID.toLowerCase(),
                USER_TYPE: config.get('USER_TYPE').TEAM.NAME
            }, function(err, user) {
                if (err)
                    service.handleError(reject, err);

                else if (user)
                    service.handleError(reject, 'This Team User Already Exists.');

                else {
                    var permalink = body.EMAIL_ID.toLowerCase().replace(' ', '').replace(/[^\w\s]/gi, '').trim();
                    var verifyToken = randomstring.generate({
                        length: 64
                    });
                    var insertedId = '';

                    _async.parallel([
                        function(callback) {
                            var referer = require('url').parse(request.headers.referer);
                            var url = referer.protocol + '//' + referer.host;

                            var template_subs = {
                                invite_url: url + '/verify/team/' + permalink + '/' + verifyToken,
                                username: body.NAME
                            }

                            service.sendTemplateEmail(config.get('NEW_INVITE_EMAIL'), body.EMAIL_ID, config.get('EMAIL_ADMIN_INVITE')['SUBJECT'], template_subs, config.get('EMAIL_ADMIN_INVITE')['TEMPLATE_ID'], function(err, response) {
                                if (err)
                                    callback(err);
                                else
                                    callback(null, response);
                            });
                        },
                        function(callback) {
                            db.collection(config.get('USER_COLLECTION')).insertOne({
                                ADMIN_ID: new mongo.ObjectID(request.auth.credentials.user._id),
                                EMAIL_ID: body.EMAIL_ID.toLowerCase(),
                                PASSWORD: service.generateHash(body.defaultPassword),
                                NAME: body.NAME,
                                USER_TYPE: config.get('USER_TYPE').TEAM.NAME,
                                VERIFY_TOKEN: verifyToken,
                                PERMALINK: permalink
                            }, function(err, docsInserted) {
                                insertedId = docsInserted.insertedId;

                                err ? callback(err) : callback(null);
                            });
                        }
                    ], function(err) {
                        if (err)
                            service.handleError(reject, err);

                        else {
                            db.collection(config.get('USER_COLLECTION')).updateOne({
                                _id: new mongo.ObjectID(request.auth.credentials.user._id.toString())
                            }, {
                                $inc: {
                                    TOTAL_SEATS_USED: 1
                                }
                            }, function(err, result) {
                                if (err)
                                    service.handleError(reject, err);

                                else {
                                    console.log('TOTAL_SEATS_USED increased by ' + result.result.n);

                                    resolve({
                                        message: 'done',
                                        insertedId: insertedId
                                    });
                                }
                            });
                        }
                    });
                }
            });
        });

        return promise;
    }

    this.saveInvitedUserDetailsHandler = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            // if (request.auth.credentials.user.USER_TYPE == config.get('USER_TYPE').STUDENT_ADMIN.NAME || request.auth.credentials.user.USER_TYPE == config.get('USER_TYPE').STUDENT_SELF.NAME) {
            //     service.handleError(reject, 'You are not allowed to buy more seats');
            //     return;
            // } else if (request.auth.credentials.user.PLAN_END_DATE < (new Date()).getTime()) {
            //     service.handleError(reject, 'Your subscription has ended. Please upgrade');
            //     return;
            // }

            if (request.auth.credentials.user.PLAN_END_DATE < (new Date()).getTime()) {
                service.handleError(reject, 'Your subscription has ended. Please upgrade');
                return;
            }

            var body = JSON.parse(request.payload);

            db.collection(config.get('USER_COLLECTION')).updateOne({
                _id: new mongo.ObjectID(body._id)
            }, {
                $set: {
                    NAME: body.NAME,
                    PASSWORD: service.generateHash(body.defaultPassword)
                }
            }, function(err, results) {
                if (err)
                    service.handleError(reject, err);

                else
                    resolve({
                        done: results.result.nModified
                    });
            });
        });

        return promise;
    }

    this.deleteTeamUserHandler = function(request, h) {
        var promise = new Promise((resolve, reject) => {

            _async.waterfall([
                function(callback) {
                    var body = JSON.parse(request.payload);

                    db.collection(config.get('USER_COLLECTION')).deleteOne({
                        _id: new mongo.ObjectID(request.params._id)
                    }, function(err, results) {
                        if (err)
                            callback(err);

                        else
                            callback(null);
                    });
                },
                function(callback) {
                    db.collection(config.get('USER_COLLECTION')).update({
                        _id: new mongo.ObjectID(request.auth.credentials.user._id)
                    }, {
                        $inc: {
                            TOTAL_SEATS_USED: -1
                        }
                    }, function(err, result) {
                        if (err)
                            callback(err);

                        else {
                            var user = request.auth.credentials.user;

                            user.TOTAL_SEATS_USED--;

                            service.changeSessionData(request, user, null);

                            callback(null);
                        }
                    });
                }
            ], function(err) {
                if (err)
                    service.handleError(reject, err);

                else {
                    resolve({
                        message: 'done'
                    });
                }
            })
        });

        return promise;
    }

    this.getProjectInvitedUsersHandler = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            var projectId;
            if (!request.query.projectId) {
                projectId = 'DEFAULT'
            } else {
                projectId = request.query.projectId
            }

            db.collection(config.get('USER_COLLECTION')).find({
                ADMIN_ID: new mongo.ObjectID(request.auth.credentials.user._id),
                "PROJECTS.PROJECT_ID": projectId
            }, {
                ADMIN_ID: 0,
                PASSWORD: 0,
                LAST_LOGGED_IN: 0,
                LAST_LOGGED_OUT: 0,
                AUTH_TOKEN: 0,
                USER_TYPE: 0
            }).toArray(function(err, docs) {
                if (err)
                    service.handleError(reject, err);

                else
                    resolve(docs);
            });
        });

        return promise;
    }

    this.sendProjectInviteHandler = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            // if (request.auth.credentials.user.USER_TYPE == config.get('USER_TYPE').STUDENT_ADMIN.NAME || request.auth.credentials.user.USER_TYPE == config.get('USER_TYPE').STUDENT_SELF.NAME) {
            //     service.handleError(reject, 'You are not allowed to buy more seats');
            //     return;
            // } else if (request.auth.credentials.user.PLAN_END_DATE < (new Date()).getTime()) {
            //     service.handleError(reject, 'Your subscription has ended. Please upgrade');
            //     return;
            // }

            if (request.auth.credentials.user.PLAN_END_DATE < (new Date()).getTime()) {
                service.handleError(reject, 'Your subscription has ended. Please upgrade');
                return;
            }

            var body = JSON.parse(request.payload);
            var projectId = !body.projectId ? 'DEFAULT' : body.projectId;

            db.collection(config.get('USER_COLLECTION')).count({
                ADMIN_ID: new mongo.ObjectID(request.auth.credentials.user._id),
                EMAIL_ID: body.EMAIL_ID.toLowerCase(),
                USER_TYPE: config.get('USER_TYPE').TEAM.NAME,
                PROJECTS: {
                    PROJECT_ID: projectId
                }
            }, function(err, count) {
                if (err)
                    service.handleError(reject, err);

                else if (count > 0)
                    service.handleError(reject, 'This Team User Already Exists in the current project.');

                else {
                    _async.parallel([
                        function(callback) {
                            var referer = require('url').parse(request.headers.referer);
                            var url = referer.protocol + '//' + referer.host;
                            db.collection(config.get('USER_COLLECTION')).findOne({
                                _id: new mongo.ObjectID(request.auth.credentials.user._id)
                            }, function(err, adminUser) {
                                if (err)
                                    service.handleError(reject, err);

                                else if (!adminUser)
                                    service.handleError(reject, 'User not found in the database');
                                else {
                                    var projectName = adminUser.PROJECTS[projectId].NAME;
                                    db.collection(config.get('USER_COLLECTION')).findOne({
                                        ADMIN_ID: new mongo.ObjectID(request.auth.credentials.user._id),
                                        EMAIL_ID: body.EMAIL_ID.toLowerCase(),
                                        USER_TYPE: config.get('USER_TYPE').TEAM.NAME,
                                    }, function(err, inv_user) {
                                        if (err)
                                            service.handleError(reject, err);

                                        else if (!inv_user)
                                            service.handleError(reject, 'Invited user name not found in the database');

                                        else {
                                            var invited_user_name = inv_user.NAME;
                                            var email_subject = body.NAME + " invited you to " + projectName + " project";
                                            var template_subs = {
                                                admin_name: body.NAME,
                                                invited_user_email: body.EMAIL_ID.toLowerCase(),
                                                invite_url: url + '/login/team',
                                                invited_user_name: invited_user_name,
                                                invited_project_name: projectName
                                            }
                                            service.sendTemplateEmail(config.get('NEW_INVITE_EMAIL'), body.EMAIL_ID, email_subject, template_subs, config.get('EMAIL_PROJECT_INVITE')['TEMPLATE_ID'], function(err, response) {
                                                if (err)
                                                    callback(err);
                                                else
                                                    callback(null, response);
                                            });
                                        }
                                    })
                                }
                            });
                        },
                        function(callback) {
                            db.collection(config.get('USER_COLLECTION')).updateOne({
                                ADMIN_ID: new mongo.ObjectID(request.auth.credentials.user._id),
                                EMAIL_ID: body.EMAIL_ID.toLowerCase(),
                                USER_TYPE: config.get('USER_TYPE').TEAM.NAME
                            }, {
                                $push: {
                                    PROJECTS: {
                                        PROJECT_ID: projectId
                                    }
                                }
                            }, function(err, docUpdated) {
                                err ? callback(err) : callback(null);
                            });
                        }
                    ], function(err, res) {
                        if (err)
                            service.handleError(reject, err);

                        else {
                            resolve(res)
                        }
                    });
                }
            });
        });

        return promise;
    }

    this.removeProjectInviteUserHandler = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            var projectId;
            if (!request.payload.projectId) {
                projectId = 'DEFAULT'
            } else {
                projectId = request.payload.projectId
            }

            db.collection(config.get('USER_COLLECTION')).updateOne({
                _id: new mongo.ObjectID(request.payload._id)
            }, {
                $pull: {
                    PROJECTS: {
                        PROJECT_ID: projectId
                    }
                }
            }, function(err, res) {
                if (err) {
                    service.handleError(reject, err);
                } else {
                    resolve(res);
                }
            });
        });

        return promise;
    }

    return this;
}
