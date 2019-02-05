module.exports = function(service, gfs) {
    var config = require('../config/config')();
    var uuid = require('uuid/v1');
    var _async = require('async');
    var mongo = require('mongodb');
    var fs = require('fs');
    var db = config.getDB();

    this.getProjects = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            db.collection(config.get('USER_COLLECTION')).findOne({
                _id: new mongo.ObjectId(request.auth.credentials.user._id)
            }, function(err, result) {
                if (err) {
                    service.handleError(reject, err);
                } else {
                    let isAdminUser = (result.USER_TYPE === config.get('USER_TYPE').ADMIN.NAME || result.USER_TYPE === config.get('USER_TYPE').STUDENT_ADMIN.NAME);
                    let isTeamUser = (result.USER_TYPE === config.get('USER_TYPE').TEAM.NAME);
                    let team_project_details = {}

                    if (isTeamUser) {
                        db.collection(config.get('USER_COLLECTION')).findOne({
                            _id: mongo.ObjectId(result.ADMIN_ID)
                        }, function(err, res) {
                            if (err) {
                                service.handleError(reject, err);
                            } else {
                                //iterating all the projects to which the team user has been invited to
                                _async.each(result.PROJECTS, function(project, eachCallback) {

                                    console.log(result.PROJECTS);
                                    console.log(project.PROJECT_ID);
                                    console.log(result.PROJECTS.indexOf(project.PROJECT_ID));

                                    team_project_details[project.PROJECT_ID] = res.PROJECTS[project.PROJECT_ID];

                                    console.log({ team_project_details });

                                    _async.parallel([
                                        function(callback) {
                                            db.collection(config.get('IMAGES_COLLECTION')).count({
                                                USER_OID: new mongo.ObjectId(result.ADMIN_ID),
                                                PROJECT_ID: project.PROJECT_ID
                                            }, function(err, count) {
                                                if (err)
                                                    callback(err)

                                                else {
                                                    team_project_details[project.PROJECT_ID].TOTAL_IMAGES = count;
                                                    callback(null);
                                                }
                                            });
                                        },
                                        function(callback) {
                                            db.collection(config.get('IMAGES_COLLECTION')).count({
                                                USER_OID: new mongo.ObjectId(result.ADMIN_ID),
                                                PROJECT_ID: project.PROJECT_ID,
                                                STATUS: 'CLASSIFIED'
                                            }, function(err, count) {
                                                if (err)
                                                    callback(err)

                                                else {
                                                    team_project_details[project.PROJECT_ID].TOTAL_CLASSIFIED_IMAGES = count;
                                                    callback(null);
                                                }
                                            });
                                        },
                                        function(callback) {
                                            db.collection(config.get('USER_COLLECTION')).count({
                                                ADMIN_ID: new mongo.ObjectID(result.ADMIN_ID),
                                                USER_TYPE: config.get('USER_TYPE').TEAM.NAME,
                                                PROJECTS: {
                                                    PROJECT_ID: project.PROJECT_ID
                                                }
                                            }, function(err, count) {
                                                if (err)
                                                    callback(err)

                                                else {
                                                    team_project_details[project.PROJECT_ID].TOTAL_INVITED_USERS = count;
                                                    callback(null);
                                                }
                                            });
                                        }
                                    ], function(err) {
                                        if (err)
                                            eachCallback(err);

                                        else
                                            eachCallback();
                                    });
                                }, function(err) {
                                    if (err)
                                        service.handleError(reject, err);

                                    else {
                                        resolve({
                                            msg: 'done',
                                            projects: team_project_details
                                        });
                                    }
                                })
                            }
                        })
                    } else {
                        _async.forEachOf(result.PROJECTS, function(project, projectId, eachCallback) {
                            _async.parallel([
                                function(callback) {
                                    db.collection(config.get('IMAGES_COLLECTION')).count({
                                        USER_OID: new mongo.ObjectId(result._id),
                                        PROJECT_ID: projectId
                                    }, function(err, count) {
                                        if (err)
                                            callback(err)

                                        else {
                                            result.PROJECTS[projectId].TOTAL_IMAGES = count;
                                            callback(null);
                                        }
                                    });
                                },
                                function(callback) {
                                    db.collection(config.get('IMAGES_COLLECTION')).count({
                                        USER_OID: new mongo.ObjectId(result._id),
                                        PROJECT_ID: projectId,
                                        STATUS: 'CLASSIFIED'
                                    }, function(err, count) {
                                        if (err)
                                            callback(err)

                                        else {
                                            result.PROJECTS[projectId].TOTAL_CLASSIFIED_IMAGES = count;
                                            callback(null);
                                        }
                                    });
                                },
                                function(callback) {

                                    if (isAdminUser) {
                                        db.collection(config.get('USER_COLLECTION')).count({
                                            ADMIN_ID: new mongo.ObjectID(result._id),
                                            USER_TYPE: config.get('USER_TYPE').TEAM.NAME,
                                            PROJECTS: {
                                                PROJECT_ID: projectId
                                            }
                                        }, function(err, count) {
                                            if (err)
                                                callback(err)

                                            else {
                                                result.PROJECTS[projectId].TOTAL_INVITED_USERS = count;
                                                callback(null);
                                            }
                                        });
                                    } else
                                        callback(null);
                                },
                            ], function(err) {
                                if (err)
                                    eachCallback(err);

                                else
                                    eachCallback();
                            });
                        }, function(err) {
                            if (err)
                                service.handleError(reject, err);

                            else {
                                resolve({
                                    msg: 'Done',
                                    projects: result.PROJECTS
                                });
                            }
                        })
                    }
                }
            })
        });

        return promise;
    }

    this.createProject = function(request, h) {
        const currentDate = new Date();
        var promise = new Promise((resolve, reject) => {

            db.collection(config.get('USER_COLLECTION')).findOne({
                _id: mongo.ObjectId(request.auth.credentials.user._id)
            }, function(err, result) {
                if (err) {
                    service.handleError(reject, err);
                } else {
                    if (result.PLAN_END_DATE < (new Date()).getTime()) {
                        service.handleError(reject, 'You are not allowed. Your Plan has ended');
                        return;
                    }
                    if (result.PROJECTS != null && result.PROJECTS[request.payload.projectName]) {
                        service.handleError(reject, 'Project with this project Name already exists.');
                    } else {
                        var newProjectObject = {
                            NAME: request.payload.projectName,
                            DATE_CREATED: new Date().getTime(),
                            ACTIVE_STORAGE: request.payload.projectStorage,
                            EXPORT_TOKEN: uuid(),
                            STORAGE_DETAILS: {
                                [request.payload.projectStorage]: config.get('DATA_MODEL').STORAGE_DATA[request.payload.projectStorage]
                            },
                            ANNOTATE_BY: request.payload.annotateBy,
                            STATUS: 'ACTIVE'
                        };

                        var userType = request.auth.credentials.user.USER_TYPE;

                        if (userType == config.get('USER_TYPE').ADMIN.NAME || userType == config.get('USER_TYPE').SELF.NAME)
                            newProjectObject['SEMANTIC_SEGMENTATION'] = request.payload.semantic_segmentation
                        newProjectObject['PROJECT_TYPE'] = request.payload.projectType

                        let projectId = uuid();

                        var user = result;
                        user.PROJECTS[projectId] = newProjectObject;

                        db.collection(config.get('USER_COLLECTION')).updateOne({
                            _id: new mongo.ObjectID(request.auth.credentials.user._id.toString())
                        }, {
                            $set: {
                                PROJECTS: user.PROJECTS
                            }
                        }, function(err, res) {
                            if (err)
                                service.handleError(reject, err);

                            else {

                                delete user.PASSWORD;

                                resolve({
                                    msg: 'done',
                                    user: user
                                });
                            }
                        });
                    }
                }
            })
        });

        return promise;
    }

    this.selectProjectFolder = function(request, h) {
        var promise = new Promise(function(resolve, reject) {
            this.getUser(request).then(user => {
                user.PROJECTS[request.payload.projectId].STORAGE_DETAILS.GOOGLE_DRIVE.FOLDER_ID = request.payload.folderDetails.ID;
                user.PROJECTS[request.payload.projectId].STORAGE_DETAILS.GOOGLE_DRIVE.FOLDER_NAME = request.payload.folderDetails.NAME;

                var query = {
                    $set: {
                        PROJECTS: user.PROJECTS
                    }
                };

                db.collection(config.get('USER_COLLECTION')).findOneAndUpdate({
                    // _id: new mongo.ObjectID(request.payload.state)
                    _id: new mongo.ObjectID(request.auth.credentials.user._id)
                }, query, function(err, res) {
                    if (err)
                        service.handleError(reject, err);

                    else {
                        // var user = request.auth.credentials.user;        // Since we are not saving any project details in session, no need of this

                        // user.PROJECTS[request.payload.projectId].STORAGE_DETAILS.GOOGLE_DRIVE.FOLDER_ID = request.payload.folderId;

                        // service.changeSessionData(request, user, null);

                        resolve({
                            msg: 'done',
                            PROJECTS: user.PROJECTS
                        });
                    }
                });
            }).catch(err => {
                service.handleError(reject, err);
            })
        });

        return promise;
    }

    this.editProject = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            if (!request.auth.credentials.user.PROJECTS[request.payload.projectId])
                service.handleError(reject, 'Project doesn\'t exists.');

            db.collection(config.get('USER_COLLECTION')).updateOne({
                _id: new mongo.ObjectID(request.auth.credentials.user._id.toString())
            }, {
                $set: {
                    [request.payload.projectId]: request.payload.newDetails
                }
            }, function(err, result) {
                if (err)
                    service.handleError(reject, err);

                else {
                    var user = request.auth.credentials.user;

                    for (var key in request.payload.newDetails)
                        user.PROJECTS[request.payload.projectId][key] = request.payload.newDetails[key];

                    service.changeSessionData(request, user, null);

                    resolve('done');
                }
            });
        });

        return promise;
    }

    this.deleteProject = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            console.log(request.payload);

            var currentDate = (new Date()).getTime();

            _async.waterfall([
                function(callback) {
                    db.collection(config.get('USER_COLLECTION')).findOne({
                        _id: new mongo.ObjectID(request.auth.credentials.user._id.toString())
                    }, function(err, user) {
                        if (err)
                            callback(err);

                        else if (!user)
                            callback('No user found');

                        else if (!user.PROJECTS[request.payload.projectId])
                            callback('This Project doesn\'t exists.');

                        else
                            callback(null, user.PROJECTS);
                    });
                },
                function(userProjects, callback) {
                    var updateQuery = {
                        PROJECTS: userProjects
                    }

                    updateQuery.PROJECTS[request.payload.projectId].STATUS = 'TO_BE_DELETED';
                    updateQuery.PROJECTS[request.payload.projectId].DELETION_SCHEDULED_TIME = currentDate;

                    db.collection(config.get('USER_COLLECTION')).updateOne({
                        _id: new mongo.ObjectID(request.auth.credentials.user._id.toString())
                    }, {
                        $set: updateQuery
                    }, function(err, result) {
                        if (err)
                            callback(err);

                        else
                            callback(null);
                    });
                },
                function(callback) {
                    db.collection(config.get('WORKING_IMAGES_COLLECTION')).remove({
                        PROJECT_ID: request.payload.projectId,
                        OWNER_OID: new mongo.ObjectID(request.auth.credentials.user._id.toString())
                    }, function(err, result) {
                        if (err)
                            callback(err);

                        else {
                            console.log(result.nRemoved + ' images were removed from working collection.');
                            callback(null);
                        }
                    });
                }
            ], function(err) {
                if (err)
                    console.error(err);

                else {
                    var toBeDeletedOn = (new Date()).getTime() + config.get('DELETE_PROJECT').DELETE_TIME;

                    resolve({ toBeDeletedOn });
                }
            });
        });

        return promise;
    }

    this.cancelDeletion = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            var setQuery = {},
                unsetQuery = {};

            setQuery[request.payload.projectId + '.STATUS'] = 'ACTIVE';
            unsetQuery[request.payload.projectId + '.DELETION_SCHEDULED_TIME'] = 1;

            db.collection(config.get('USER_COLLECTION')).updateOne({
                _id: new mongo.ObjectID(request.auth.credentials.user._id.toString())
            }, {
                $set: setQuery,
                $unset: unsetQuery
            }, function(err, result) {
                if (err)
                    service.handleError(reject, err, 'Error while canceling the deletion of the project.')

                else
                    resolve('done');
            });
        });

        return promise;
    }

    this.getProjectIdFromImageHandler = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            db.collection(config.get('IMAGES_COLLECTION')).findOne({
                _id: new mongo.ObjectID(request.params.imageId)
            }, function(err, image) {
                if (err)
                    service.handleError(reject, err, 'Error while fetching project.')

                else
                    resolve({
                        projectId: image.PROJECT_ID
                    });
            });
        });

        return promise;
    }

    this.getUser = function(request) {
        return new Promise((resolve, reject) => {
            db.collection(config.get('USER_COLLECTION')).findOne({
                _id: new mongo.ObjectID(request.auth.credentials.user._id)
            }, {
                PASSWORD: 0
            }, function(err, result) {
                if (err) {
                    service.handleError(reject, err);
                } else if (result) {
                    resolve(result);
                } else {
                    service.handleError(reject, 'User doesn\'t exists.');
                }
            })
        });
    }

    this.createProjectReadInstructions = function(request, h) {
        var promise = new Promise((resolve, reject) => {

            db.collection(config.get('GLOBAL_README_COLLECTION')).insertOne({
                USER_OID: new mongo.ObjectID(request.auth.credentials.user._id.toString()),
                PROJECT_ID: request.payload.projectId,
                README_CONTENT: request.payload.editorData,
                VERSION: request.payload.versionCount + 1
            }, function(err, docsInserted) {
                if (err) {
                    console.error(err);
                    service.handleError(reject, err, 'Error while saving read me details.');
                } else
                    resolve({
                        msg: "Successfully published details...."
                    });
            })

        });

        return promise;
    }

    this.getProjectReadInstructions = function(request, h) {
        var promise = new Promise((resolve, reject) => {

            console.log("USER_ID : " + request.auth.credentials.user._id.toString() + "   PROJECT ID : " + request.params._projectId);
            db.collection(config.get('GLOBAL_README_COLLECTION')).find({
                    $query: {
                        USER_OID: new mongo.ObjectID(request.auth.credentials.user._id.toString()),
                        PROJECT_ID: request.params._projectId
                    },
                    $orderby: {
                        VERSION: 1
                    }
                })
                .toArray(function(err, result) {
                    if (err) {
                        console.error(err);
                        service.handleError(reject, err, 'Error while fetching read me details.');
                    } else
                        resolve(result);
                });
        });

        return promise;
    }

    this.uploadInstructionImg = function(request, h) {
        var promise = new Promise((resolve, reject) => {

            var file = request.payload.file;
            var fileDetails = file['hapi'];

            var writeStream = gfs.createWriteStream({
                filename: fileDetails.filename,
                mode: 'w'
            });

            writeStream.on('close', function(file) {
                console.log("Saved file : " + file._id);
                //retrive image
                resolve({
                    'url': config.get('README_IMG_URL') + config.get('HOST_NAME') + '/instructionsImg/' + file._id
                });
            });

            file.pipe(writeStream);
        });

        return promise;
    }

    this.getInstructionImg = async function(request, reply) {

        var promise = new Promise((resolve, reject) => {
            try {
                var _imageId = request.params._imageid;

                gfs.findOne({
                    _id: _imageId
                }, function(err, file) {
                    if (err)
                        service.handleError(reject, err, 'Error while getting the image.');

                    else if (file)
                        resolve(gfs.createReadStream({
                            filename: file.filename
                        }));

                    else
                        service.handleError(reject, 'No file was found for image');
                });
            } catch (e) {
                service.handleError(reject, e, 'Error while getting the image.');
            }
        });

        return promise;
    }

    this.sendAcceptProjectLink = function(request, h) { // For freelancer projects
        var promise = new Promise((resolve, reject) => {

            var permalink;

            _async.waterfall([
                function(callback) {
                    db.collection(config.get('USER_COLLECTION')).findOne({
                        _id: new mongo.ObjectId(request.auth.credentials.user._id)
                    }, function(err, user) {
                        if (err) {
                            console.error(err);
                            callback('Error while fetching project details');
                        } else if (user) {
                            var project = user.PROJECTS[request.payload.PROJECT_ID];

                            if (project && project.ANNOTATE_BY == config.get('USER_TYPE').FREELANCER.NAME && project.PERMALINK)
                                callback('Already sent invitations to freelancers for this project!');

                            else if (project && project.ANNOTATE_BY == config.get('USER_TYPE').FREELANCER.NAME && project.FREELANCER_OID)
                                callback('Project already assigned to a freelancer!');

                            else if (project && project.ANNOTATE_BY == config.get('USER_TYPE').FREELANCER.NAME && !(project.PERMALINK) && !(project.FREELANCER_OID))
                                callback(null);

                            else
                                callback("Project does not exist!");

                        } else {
                            callback('User does not exist!');
                        }
                    });
                },
                function(callback) {
                    permalink = uuid();

                    var upadteData = {
                        [`PROJECTS.${request.payload.PROJECT_ID}.PERMALINK`]: permalink
                    };

                    db.collection(config.get('USER_COLLECTION')).updateOne({
                            _id: new mongo.ObjectId(request.auth.credentials.user._id),
                        }, {
                            $set: upadteData
                        },
                        function(err, res) {
                            if (err) {
                                console.error(err);
                                callback('Error while updating project data');
                            } else {
                                console.log('permalink saved in project');
                                callback(null);
                            }
                        });
                },
                function(callback) {
                    // Send email to freelancers
                    db.collection(config.get('USER_COLLECTION')).find({
                        USER_TYPE: config.get('USER_TYPE').FREELANCER.NAME,
                        ACTIVE_PROJECT: {
                            $exists: false
                        },
                        BASIC_TRAINING_COMPLETED: true,
                        ERROR_FREE_PERCENTAGE: {
                            $gte: 97
                        },
                        ON_TIME_COMPLETION_PERCENTAGE: {
                            $gte: 99
                        }
                    }).toArray(function(err, results) {
                        if (err)
                            callback(err)

                        else {
                            var Url = require('url');
                            var referer = Url.parse(request.headers.referer);
                            var url = referer.protocol + '//' + referer.host;

                            results.forEach(freelancer => {
                                var id = freelancer._id.toString();
                                var template_subs = {
                                    invite_url: url + '/freelancer/verify_permalink/' + request.payload.PROJECT_ID + '/' + permalink + '/' + id,
                                    invited_user_name: freelancer.NAME,
                                    invited_user_email: freelancer.EMAIL_ID
                                };

                                service.sendTemplateEmail(config.get('NEW_INVITE_EMAIL'), freelancer.EMAIL_ID, config.get('EMAIL_FREELANCER_PROJECT_INVITATION').SUBJECT, template_subs, config.get('EMAIL_FREELANCER_PROJECT_INVITATION').TEMPLATE_ID, function(err, response) {
                                    if (err)
                                        console.error(err);

                                    else {
                                        console.log('Project invitation sent to freelancer ' + freelancer.EMAIL_ID);
                                    }
                                });
                            });
                            callback(null);
                        }
                    })
                }
            ], function(err) {
                if (err)
                    service.handleError(reject, err);

                else
                    resolve({
                        success: true
                    });
            });
        });

        return promise;
    }

    return this;
}
