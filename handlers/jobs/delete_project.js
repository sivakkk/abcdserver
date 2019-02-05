module.exports = function(service) {
    var config = require('../../config/config')();
    var _async = require('async');
    var mongo = require('mongodb');
    var db = config.getDB();

    var skip = 0, toBeDeletedCount = 0, preDeleteCount = 0, projectDeletedCount = 0;
    var noMoreRecords;
    var setIntervalId;

    function start(skip) {
        var stream = db.collection(config.get('USER_COLLECTION')).find({
            $or : [{
                    USER_TYPE: config.get('USER_TYPE').ADMIN.NAME
                }, {
                    USER_TYPE: config.get('USER_TYPE').STUDENT_ADMIN.NAME
                }, {
                    USER_TYPE: config.get('USER_TYPE').SELF.NAME
                }, {
                    USER_TYPE: config.get('USER_TYPE').STUDENT_SELF.NAME
                }]
            }).skip(skip).limit(config.get('DELETE_PROJECT').BATCH_SIZE)).stream();

        noMoreRecords = true;

        stream.on('data', function (item) {
            for(var project in item.PROJECTS) {
                if(item.PROJECTS[project].STATUS == 'TO_BE_DELETED') {
                    var date = new Date();

                    toBeDeletedCount++;

                    if(date.getTime() - item.PROJECTS[project].DELETION_SCHEDULED_TIME > config.get('DELETE_PROJECT').DELETE_TIME) {
                        _async.parallel([
                            function (callback) {
                                db.collection(config.get('USER_COLLECTION')).update({
                                    _id : new mongo.ObjectID(item._id.toString())
                                }, {
                                    $unset : {
                                        PROJECTS : {
                                            [project] : 1
                                        }
                                    }
                                }, function (err, result) {
                                    if(err)
                                        console.error(err);

                                    else if(result.result.n < 1)
                                        callback('No records were updated while deleting the project');

                                    else
                                        callback(null);
                                });
                            }, function (callback) {
                                db.collection(config.get('IMAGES_COLLECTION')).remove({
                                    PROJECT_ID : project,
                                    USER_OID : new mongo.ObjectID(item._id.toString())
                                }, function (err, result) {
                                    if(err)
                                        callback(err);

                                    else {
                                        console.log(result.nRemoved + ' images were removed.');
                                        callback(null);
                                    }
                                });
                            }, function (callback) {
                                service.sendTemplateEmail(config.get('NEW_INVITE_EMAIL'), request.payload.email, config.get('EMAIL_DELETE_WARNING').SUBJECT, template_subs, config.get('EMAIL_DELETE_WARNING').TEMPLATE_ID, function(err, response) {
                                    if (err)
                                        console.error(err);

                                    else
                                        console.log('Project deletition email has been sent.');
                                });
                            }
                        ], function (err) {
                            if(err)
                                console.error(err);
                            else {
                                projectDeletedCount++;
                            }
                        });
                    }

                    else if(date.getTime() - item.PROJECTS[project].DELETION_SCHEDULED_TIME > config.get('DELETE_PROJECT').PRE_DELETE_WARNING_TIME) {
                        service.sendTemplateEmail(config.get('NEW_INVITE_EMAIL'), request.payload.email, config.get('EMAIL_PRE_DELETE_WARNING').SUBJECT, template_subs, config.get('EMAIL_PRE_DELETE_WARNING').TEMPLATE_ID, function(err, response) {
                            if (err)
                                console.error(err);

                            else {
                                console.log('Project Pre delete warning email has been sent.');
                                preDeleteCount++;
                            }
                        });
                    }
                }
            }

            noMoreRecords = false;
        });

        stream.on('error', function (err) {
            console.error(err);

            cancelInterval(setIntervalId);
        });

        stream.on('end', function () {
            if(!noMoreRecords)
                start(skip + config.get('DELETE_PROJECT').BATCH_SIZE));

            else {
                console.log('Project Delete Job completed at ' + new Date());
                console.log('Total Projects found in TO_BE_DELETED state : ' + toBeDeletedCount);
                console.log('Total Pre Delete Warning sent : ' + preDeleteCount);
                console.log('Total Projects Deleted: ' + projectDeletedCount);
            }
        });
    }
}
