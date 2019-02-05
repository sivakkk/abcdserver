module.exports = function(service, gfs) {
    var config = require('../config/config')();
    var uuid = require('uuid/v1');
    var _async = require('async');
    var mongo = require('mongodb');
    var fs = require('fs');
    var db = config.getDB();

    this.verifyPermalinkFreelanceProject = function (request, h) {
        var promise = new Promise((resolve, reject) => {

            var body = request.payload;

            var query = {[`PROJECTS.${body.PROJECT_ID}`]: {$exists: true}};

            _async.waterfall([
                function(callback) {
                    db.collection(config.get('USER_COLLECTION')).findOne(query, function(err, user) {
                        if (err) {
                            console.error(err);
                            callback('Error while fetching project details');
                        }
                        else if (user) {
                            var project = user.PROJECTS[body.PROJECT_ID];

                            if (project.ANNOTATE_BY == config.get('USER_TYPE').FREELANCER.NAME && project.PERMALINK == body.PERMALINK && !project.FREELANCER_OID) {
                                console.log('Assign Project to freelancer');
                                callback(null, user);
                            }
                            else if(project.ANNOTATE_BY == config.get('USER_TYPE').FREELANCER.NAME && project.FREELANCER_OID){
                                callback("Sorry, the project is assigned to other freelancer since it’s a first come first");
                            }
                            else {
                                callback("The link is invalid!");
                            }
                        }
                        else {
                            console.log('Invalid link');
                            callback('The link is invalid!');
                        }
                    });
                },
                function(user, callback) {
                    this.calculateProjectTimeframe(body.PROJECT_ID)
                        .then( data => callback(null, user, data.totalImages, data.calculatedTime))
                        .catch( err =>  callback(err));
                },
                function(user, imgCount, timeframe, callback) {
                    db.collection(config.get('USER_COLLECTION')).findOneAndUpdate({
                        _id: new mongo.ObjectId(body.FREELANCER_OID),
                        USER_TYPE: config.get('USER_TYPE').FREELANCER.NAME}
                        ,{
                            $set: {
                                ACTIVE_PROJECT: body.PROJECT_ID,
                                PROJECT_STATUS: 'TRAINING',
                                ADMIN_ID: new mongo.ObjectId(user._id),
                                PROJECT_TIMEFRAME: timeframe,
                                [`PROJECTS.${body.PROJECT_ID}`]: {
                                    NAME: user.PROJECTS[body.PROJECT_ID].NAME,
                                    STATUS: 'TRAINING',
                                    TOTAL_IMAGES: imgCount,
                                    TOTAL_IMAGES_CLASSIFIED: 0,
                                    TOTAL_IMAGES_ERROR: 0,
                                    TOTAL_TIME: 0
                                }
                            }
                        }, function(err, res) {
                        if (err) {
                            console.error(err);
                            callback('Error while updating project data');
                        }
                        else if (res.value)
                            callback(null, user, res.value);

                        else
                            callback('The link is Invalid!')

                    });
                },
                function(user, freelancer, callback) {
                    var setData = {[`PROJECTS.${body.PROJECT_ID}.FREELANCER_OID`]: new mongo.ObjectId(body.FREELANCER_OID) };
                    var unsetData = {[`PROJECTS.${body.PROJECT_ID}.PERMALINK`]: ''};

                    db.collection(config.get('USER_COLLECTION')).update({
                        _id: user._id
                    }, {
                        $set: setData,
                        $unset: unsetData
                    }, function(err, resp) {
                        if (err) {
                            console.error(err);
                            callback('Error while updating project data');
                        } else {
                            console.log('Project ' + body.PROJECT_ID + ' assigned to freelancer ' + body.FREELANCER_OID);

                            var template_subs = { project_owner_name: user.NAME };

                            service.sendTemplateEmail(config.get('NEW_INVITE_EMAIL'), user.EMAIL_ID, config.get('EMAIL_FREELANCER_PROJECT_INVITATION_ACCEPTED')['SUBJECT'], template_subs, config.get('EMAIL_FREELANCER_PROJECT_INVITATION_ACCEPTED')['TEMPLATE_ID'], function(err, response) {
                                if (err)
                                    callback(err);

                                else {
                                    console.log('Project accepted mail sent to owner ' + user.EMAIL_ID);
                                    var template_subs = { freelancer_name: freelancer.NAME };

                                    service.sendTemplateEmail(config.get('NEW_INVITE_EMAIL'), freelancer.EMAIL_ID, config.get('EMAIL_NEXT_STEPS_TO_FREELANCER')['SUBJECT'], template_subs, config.get('EMAIL_NEXT_STEPS_TO_FREELANCER')['TEMPLATE_ID'], function(err, response) {
                                        if (err)
                                            callback(err);

                                        else {
                                            console.log('Project accepted mail sent to ' + freelancer.EMAIL_ID);
                                            callback(null);
                                        }
                                    });
                                }
                            });
                        }
                    });
                }
            ], function(err) {
                if (err)
                    service.handleError(reject, err);

                else
                    resolve({
                        redirect: 'freelancer/login'
                    });
            });
        });

        return promise;
    }

    this.getFreelancerProjects = function (request, h) {
        var promise = new Promise((resolve, reject) => {
            db.collection(config.get('USER_COLLECTION')).findOne({
                _id: new mongo.ObjectID(request.auth.credentials.user._id)
            }, {
                PASSWORD: 0
            }, function(err, result) {
                if (err)
                    service.handleError(reject, err);

                else if (result)
                    resolve({projects: result.PROJECTS});

                else
                    service.handleError(reject, "User does not exist!.");
            })
        });
        return promise;
    }


    this.calculateProjectTimeframe = function(projectId) {
        var promise = new Promise((resolve, reject) => {

            db.collection(config.get('IMAGES_COLLECTION')).aggregate([
                {$match: {PROJECT_ID: projectId}},
                {$group: {_id: "$STATUS", CLASSIFICATION_TIME: {"$sum": "$CLASSIFICATION_TIME"}, COUNT: {"$sum":1} }}
            ], function(err, docs) {
                if (err)
                    reject(err)

                else {
                    console.log('docs', docs);

                    var unclassifiedImages = 0,
                        classifiedImages = 0,
                        classificationTime = 0,
                        calculatedTime = 0;

                    docs.forEach(doc => {
                        if (doc._id === 'NEW' || doc._id === 'ASSIGNED')
                            unclassifiedImages += doc.COUNT;

                        if (doc._id === 'CLASSIFIED') {
                            classifiedImages = doc.COUNT;
                            classificationTime = doc.CLASSIFICATION_TIME;
                        }
                    });

                    var totalImages = unclassifiedImages + classifiedImages;
                    calculatedTime = (classificationTime / classifiedImages) * totalImages;
                    calculatedTime += ((calculatedTime / 100) * config.get('FREELANCER_TIMEFRAME_TOLERANCE'));
                    resolve ({calculatedTime: calculatedTime, totalImages: totalImages});
                }
            });
        });

        return promise;
    }

    return this;
}
