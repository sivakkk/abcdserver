module.exports = function(db, config) {
    var config = require('../config/config')();
    var bcrypt = require('bcrypt-nodejs');
    var sendgrid = require('sendgrid')(config.get('SENDGRID_API_KEY'));
    var mailHelper = require('sendgrid').mail;
    var _async = require('async');
    var vm = this;
    var mongo = require('mongodb');
    var boom = require('boom');
    var fs = require('fs');
    var httpCall = require('request');
    var db = config.getDB();

    var _this = this;

    vm.isEmail = function(email) {
        var re = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
        return re.test(email);
    }

    vm.getUserAgent = function(req) {
        return useragent.parse(req.headers['user-agent']).toString().split(' / ');
    }

    vm.sendTemplateEmail = function(fromEmail, toEmail, subject, template_subs, template_id, callback) {
        msgConfig = {
            "content": [{
                "type": "text/html",
                "value": "<html><p>Hello, world!</p></html>"
            }],
            "from": {
                "email": fromEmail,
                "name": "no-reply"
            },
            "replyTo": 'no-repy@oclavi.com',
            "personalizations": [{
                "to": [{
                    "email": toEmail
                }],
                "substitutionWrappers": ['{{', '}}'],
                "substitutions": template_subs,
            }],
            "subject": subject,
            "template_id": template_id,
        };
        var request = sendgrid.emptyRequest({
            method: 'POST',
            path: '/v3/mail/send',
            body: msgConfig
        });

        sendgrid.API(request, function(err, response) {
            err ? callback(err) : callback(null, response);
        });
    }

    vm.sendEmail = function(fromEmail, toEmail, subject, content, callback) {
        var fromEmail = new mailHelper.Email(fromEmail);
        var toEmail = new mailHelper.Email(toEmail);
        var content = new mailHelper.Content('text/html', content);
        var mail = new mailHelper.Mail(fromEmail, subject, toEmail, content);

        var request = sendgrid.emptyRequest({
            method: 'POST',
            path: '/v3/mail/send',
            body: mail.toJSON()
        });

        sendgrid.API(request, function(err, response) {
            err ? callback(err) : callback(null, response);
        });
    }

    vm.generateHash = function(password) {
        return bcrypt.hashSync(password, bcrypt.genSaltSync(8), null);
    };

    vm.encode = function(data, fileName) {
        //file extension without the dot character
        var fileExtension = fileName.substring(fileName.lastIndexOf('.') + 1);
        var mimeType = config.get('IMAGE_MIME_TYPE')[fileExtension] ? config.get('IMAGE_MIME_TYPE')[fileExtension] : config.get('IMAGE_MIME_TYPE').DEFAULT;

        return mimeType + Buffer.from(data).toString('base64');
    }

    vm.handleError = function(reject, err, uiMessage, statusCode = 400) {
        console.error({
            uiMessage,
            err,
            statusCode
        });

        //if the promise was rejected with a string error message
        if (typeof err == 'string')
            reject(boom.boomify(new Error(err), {
                statusCode: statusCode
            }));

        // if the promise was rejected with a custom message
        else if (uiMessage)
            reject(boom.boomify(new Error(uiMessage), {
                statusCode: statusCode
            }));

        //the raw javascript error object would be returned
        else
            reject(boom.boomify(err, {
                statusCode: statusCode
            }));
    }

    vm.changeSessionData = function(request, user, admin) {
        if (!user && !admin)
            return;

        var oldSid = request.auth.credentials.sid;
        var oldUser = request.auth.credentials.user;
        var oldAdmin = request.auth.credentials.admin;

        var newCookie = {
            sid: oldSid,
            user: oldUser,
            admin: oldAdmin
        };

        if (user)
            newCookie['user'] = user;

        if (admin)
            newCookie['admin'] = admin;

        request.cookieAuth.set(newCookie);
    }

    vm.resentVerificationMail = function(request, h) {
        var Url = require('url');

        var promise = new Promise((resolve, reject) => {

            var email = request.payload.email;
            db.collection(config.get('USER_COLLECTION')).findOne({
                EMAIL_ID: email
            }, function(err, user) {
                if (err)
                    vm.handleError(reject, err);

                var referer = Url.parse(request.headers.referer);
                var url = referer.protocol + '//' + referer.host;

                var template_subs = {
                    verify_url: url + '/verify/' + user.USER_TYPE + '/' + user.PERMALINK + '/' + user.VERIFY_TOKEN,
                    username: user.NAME
                }

                vm.sendTemplateEmail(config.get('NEW_INVITE_EMAIL'), request.payload.email, config.get('EMAIL_ACCOUNT_ACTIVATION')['SUBJECT'], template_subs, config.get('EMAIL_ACCOUNT_ACTIVATION')['TEMPLATE_ID'], function(err, response) {
                    if (err)
                        vm.handleError(reject, err);

                    else {
                        resolve({});
                    }
                });
            });
        });

        return promise;
    }

    vm.isAlreadyAuthenticated = function(request, h) {
        var promise = new Promise((resolve, reject) => {

            if (request.auth.isAuthenticated) {
                var user = request.auth.credentials.user;
                var userType = user.USER_TYPE;
                if (userType == config.get('USER_TYPE').ADMIN.NAME || userType == config.get('USER_TYPE').STUDENT_ADMIN.NAME) {
                    resolve({
                        user: user,
                        redirect: '/profile'
                    });
                } else if (userType == config.get('USER_TYPE').TEAM.NAME) {
                    resolve({
                        user: user,
                        redirect: '/profile'
                    });
                } else if (userType == config.get('USER_TYPE').SELF.NAME || userType == config.get('USER_TYPE').STUDENT_SELF.NAME) {
                    resolve({
                        user: user,
                        redirect: '/profile'
                    });
                } else if (userType == config.get('USER_TYPE').FREELANCER.NAME) {
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
            } else {
                resolve({
                    isAuthenticated: false
                });
            }
        });

        return promise;
    }

    vm.getImageForClassifyScreen = function(request, user, admin, projectId, callback) {
        let id = admin ? admin._id.toString() : user._id.toString();

        db.collection(config.get('USER_COLLECTION')).findOne({
            _id: new mongo.ObjectId(id)
        }, function(err, result) {
            if (err)
                callback(null, err);

            else if (result) {
                db.collection(config.get('WORKING_IMAGES_COLLECTION')).findOne({
                    USER_OID: new mongo.ObjectID(user._id.toString()),
                    PROJECT_ID: projectId
                }, function(err, workingImage) {
                    if (err)
                        callback(null, err);

                    else if (workingImage) {
                        console.log('Working image found for ' + (admin ? admin.EMAIL_ID : user.EMAIL_ID));

                        callback(null, {
                            redirect: 'classify/' + workingImage.OBJECT_OID.toString(),
                            data: workingImage.LABEL_DETAILS,
                            user: user,
                            admin: admin
                        });
                    } else {
                        console.log('No existing Working image found for ' + user.EMAIL_ID);

                        if (user.USER_TYPE === config.get('USER_TYPE').FREELANCER.NAME && user.PROJECT_STATUS === 'TRAINING') {
                            // Only for freelancer training
                            db.collection(config.get('FREELANCER_VALIDATION_COLLECTION')).findOne({
                                PROJECT_ID: projectId,
                                TRAINING: {
                                    $exists: false
                                }
                            }, function(err, validationImg) {
                                if (err)
                                    callback(null, err);

                                else if (validationImg) {
                                    console.log('image found for ' + user.EMAIL_ID + ' for freelancer validation');

                                    callback(null, {
                                        redirect: 'classify/' + validationImg.OBJECT_OID.toString(),
                                        data: validationImg.LABEL_DETAILS,
                                        user: user,
                                        admin: admin
                                    });
                                } else {
                                    var queryBy = {
                                        _id: new mongo.ObjectID(user._id.toString())
                                    };
                                    var updateData = {
                                        $set: {
                                            PROJECT_STATUS: 'ACTIVE',
                                            [`PROJECTS.${projectId}.STATUS`]: 'ACTIVE'
                                        }
                                    };

                                    vm.changeFreelancerProjectStatus(queryBy, updateData)
                                        .then(() => {
                                            user.PROJECT_STATUS = 'ACTIVE';
                                            vm.changeSessionData(request, user, null);

                                            vm.sendMailForFreelancerProject(admin, user, 'ACTIVE')
                                                .then(() => callback('No more images found for training!'))
                                        })
                                        .catch(err => callback(err));
                                }
                            });
                        }

                        else {
                            db.collection(config.get('IMAGES_COLLECTION')).findAndModify({
                                    USER_OID: new mongo.ObjectID(id),
                                    STATUS: 'NEW',
                                    OBJECT_STORAGE_NAME: result.PROJECTS[projectId].ACTIVE_STORAGE,
                                    PROJECT_ID: projectId,
                                    SKIPPED_BY_USERS: {
                                        $nin: [new mongo.ObjectId(id)]
                                    }
                                },
                                [], {
                                    $set: {
                                        STATUS: 'ASSIGNED'
                                    }
                                }, {
                                    upsert: false
                                },
                                function(err, data) {
                                    if (err)
                                        callback(err);

                                    else if (!data.value) {
                                        if (user.USER_TYPE === config.get('USER_TYPE').FREELANCER.NAME && user.PROJECT_STATUS === 'ACTIVE') {
                                            db.collection(config.get('IMAGES_COLLECTION')).aggregate([{
                                                    $match: {
                                                        PROJECT_ID: projectId
                                                    }
                                                },
                                                {
                                                    $group: {
                                                        _id: "$USER_OID",
                                                        CLASSIFICATION_TIME: {
                                                            "$sum": "$CLASSIFICATION_TIME"
                                                        }
                                                    }
                                                }
                                            ], function(err, doc) {
                                                if (err)
                                                    reject(err)

                                                else {
                                                    var queryBy = {
                                                        _id: new mongo.ObjectID(user._id.toString())
                                                    };
                                                    var updateData = {
                                                        $set: {
                                                            [`PROJECTS.${projectId}.STATUS`]: 'COMPLETED',
                                                        },
                                                        $unset: {
                                                            PROJECT_STATUS: '',
                                                            ACTIVE_PROJECT: '',
                                                            ADMIN_ID: ''
                                                        }
                                                    };

                                                    timeDiff_percentage = ((doc[0].CLASSIFICATION_TIME - user.PROJECT_TIMEFRAME) / user.PROJECT_TIMEFRAME) * 100;

                                                    if (timeDiff_percentage <= 0)
                                                        updateData['$set']['ON_TIME_COMPLETION_PERCENTAGE'] = (100 + user.ON_TIME_COMPLETION_PERCENTAGE) / 2;

                                                    else
                                                        updateData['$set']['ON_TIME_COMPLETION_PERCENTAGE'] = ((100 - timeDiff_percentage) + user.ON_TIME_COMPLETION_PERCENTAGE) / 2;

                                                    vm.changeFreelancerProjectStatus(queryBy, updateData)
                                                        .then(() => {
                                                            delete user.PROJECT_STATUS;
                                                            delete user.ACTIVE_PROJECT;
                                                            delete user.ADMIN_ID;
                                                            delete user.PROJECT_TIMEFRAME;

                                                            queryBy = {
                                                                _id: new mongo.ObjectID(admin._id.toString())
                                                            };
                                                            updateData = {
                                                                $set: {
                                                                    [`PROJECTS.${projectId}.STATUS`]: 'COMPLETED'
                                                                }
                                                            };
                                                            vm.changeFreelancerProjectStatus(queryBy, updateData)
                                                                .then(() => {
                                                                    vm.changeSessionData(request, user, null);

                                                                    vm.sendMailForFreelancerProject(admin, user, 'COMPLETED')
                                                                        .then(() => callback('No more images were found!'))
                                                                });
                                                        })
                                                        .catch(err => callback(err));
                                                }
                                            });
                                        } else
                                            callback('No more images were found');
                                    } else {
                                        callback(null, {
                                            redirect: 'classify/' + data.value._id.toString(),
                                            data: new Array(),
                                            user: user,
                                            admin: admin
                                        });
                                    }
                                });
                        }
                    }
                });
            }
        });
    }

    vm.getChannelVideos = function(requestpayload, h) {
        var promise = new Promise(function(resolve, reject) {

            var youTubeChannelUrl = config.get('YOUTUBE_API').CHANNELS_API + config.get('YOUTUBE_API').API_KEY;

            // Gets YouTube Channel Uploads
            httpCall(youTubeChannelUrl, {
                json: true
            }, (err, res, body) => {
                if (err) {
                    console.error(err);
                    service.handleError(reject, err);
                }
                if (res) {
                    var channelCallResult = res.toJSON();
                    var channelUploadsKey = channelCallResult.body.items[0].contentDetails.relatedPlaylists.uploads;
                    console.log("UPLOAD KEY :" + channelUploadsKey);

                    var youTubePlayListItemUrl = config.get('YOUTUBE_API').PLAYLIST_ITEM_API + channelUploadsKey + config.get('YOUTUBE_API').API_KEY;
                    // Gets YouTube Channel Playlist Items
                    httpCall(youTubePlayListItemUrl, {
                        json: true
                    }, (err, res, body) => {
                        if (err) {
                            console.error(err);
                            service.handleError(reject, err);
                        }
                        if (res) {
                            console.log("Successfully got channel palylist items");
                            var howToWorkVideos = [];
                            var result = res.toJSON();
                            result.body.items.forEach(element => {
                                howToWorkVideos.push({
                                    title: element.snippet.title,
                                    description: element.snippet.description,
                                    defaultThumnail: element.snippet.thumbnails.default,
                                    videoUrl: config.get('YOUTUBE_API').EMBED_URL + element.snippet.resourceId.videoId
                                });
                            });

                            resolve({
                                videoCollection: howToWorkVideos
                            });
                        }
                    });

                }
            });

        });

        return promise;
    }

    vm.checkClassifiedImageCount = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            var user = request.auth.credentials.admin ? request.auth.credentials.admin : request.auth.credentials.user;

            db.collection(config.get('IMAGES_COLLECTION')).count({
                USER_OID: new mongo.ObjectID(user._id),
                STATUS: 'CLASSIFIED'
            }, function(err, count) {
                if (err)
                    service.handleError(reject, err);

                else {
                    if (user.USER_TYPE === config.get('USER_TYPE').STUDENT_SELF.NAME && count >= config.get('USER_TYPE').STUDENT_SELF.SUBSCRIPTION_FLAG.LIMITS.IMAGE_LIMIT)
                        service.handleError(reject, `You have already exceeded the image limit. Please upgrade your account`);

                    else if (user.USER_TYPE === config.get('USER_TYPE').STUDENT_ADMIN.NAME && count >= config.get('USER_TYPE').STUDENT_ADMIN.SUBSCRIPTION_FLAG.LIMITS.IMAGE_LIMIT)
                        service.handleError(reject, `You have already exceeded the image limit, Please ask your admin to upgrade account.`);

                    else
                        resolve('Can Proceed.');
                }
            })
        });

        return promise;
    }

    vm.serverCheck = function(res) {
        console.log('server check api');
        return res.statusCode = 200;
    }

    vm.getPlanForSeat = function(emailAddress, seats) {
        console.log('service.getPlanForSeat');
        console.log(arguments);

        var plans = JSON.parse(JSON.stringify(config.get('PAYMENT_PLANS')));
        var whiteListedEmails = config.get('WHITELIST_EMAIL_ADDRESSES_FOR_LOW_PRICES').EMAIL_ADDRESSES;
        var planPrice;

        if (whiteListedEmails.indexOf(emailAddress) != -1) {
            console.log('Whitelisted Email for testing');

            //less priced plan for white listed emails
            return config.get('WHITELIST_EMAIL_ADDRESSES_FOR_LOW_PRICES')[config.get('DEFAULT_CURRENCY')];
        }

        console.log('Searching for plans for', seats, 'seats');

        plans.forEach(function(plan) {
            if ((seats >= plan.start) && (seats <= plan.end)) {
                planPrice = plan[config.get('DEFAULT_CURRENCY')];

                return false;
            }
        });

        return planPrice;
    }

    vm.getBillingAmount = function(user, planAmount, planDuration, seatsToBePurchased, buyMoreSeats) {
        console.log('service.getBillingAmount');
        console.log(arguments);

        var currentDate = new Date();
        var result = {
            seats: 0,
            INR: {
                subTotal: 0,
                tax: 0,
                total: 0,
                planAmount: planAmount
            }
        };

        if (user.USER_TYPE == config.get('USER_TYPE').STUDENT_ADMIN.NAME || user.USER_TYPE == config.get('USER_TYPE').STUDENT_SELF.NAME) {
            console.log('the user is a free user and is doing the payment to upgrade his account to the paid one');

            result.planStartDate = currentDate.getTime();
            result.planEndDate = currentDate.setMonth(currentDate.getMonth() + planDuration);
            result.billingDays = Math.ceil((result.planEndDate - result.planStartDate) / 1000 / 3600 / 24);
            result.INR.subTotal = planDuration * planAmount;

            if (user.USER_TYPE == config.get('USER_TYPE').STUDENT_ADMIN.NAME) {
                result.seats = user.TOTAL_SEATS_PURCHASED;
                result.INR.subTotal = result.INR.subTotal * result.seats;
            }
        } else if (buyMoreSeats) {
            console.log('user is trying to buy new seats into his current subscription');

            result.seats = seatsToBePurchased;
            result.planStartDate = user.PLAN_START_DATE;
            result.planEndDate = user.PLAN_END_DATE;
            result.billingDays = Math.ceil((user.PLAN_END_DATE - currentDate.getTime()) / 1000 / 3600 / 24);

            // 28 days -> happens in the case of trial users
            if (user.PLAN_END_DATE - user.PLAN_START_DATE < 28 * 24 * 60 * 60 * 1000)
                result.INR.subTotal = (user.PLAN_END_DATE - currentDate.getTime()) / (30 * 24 * 60 * 60 * 1000) * planAmount * seatsToBePurchased;

            else
                result.INR.subTotal = (user.PLAN_END_DATE - currentDate.getTime()) / (user.PLAN_END_DATE - user.PLAN_START_DATE) * planAmount * seatsToBePurchased;
        } else if (user.USER_TYPE == config.get('USER_TYPE').ADMIN.NAME || user.USER_TYPE == config.get('USER_TYPE').SELF.NAME) {
            console.log('the user is a paid user already');

            if (user.PLAN_END_DATE > currentDate.getTime()) {
                console.log('user is doing a pre-expiry payment for his current subscription');
                console.log('not allowed as of now');
                console.log('upgrade button is enabled ony after plan expiry');

                result.seats = user.TOTAL_SEATS_PURCHASED;
                result.planStartDate = vm.firstDateOfNextMonth(currentDate);
                result.planEndDate = vm.lastDateOfNextMonth(currentDate);
                result.billingDays = vm.daysInMonth(currentDate.getMonth() + 1, currentDate.getFullYear());
                result.INR.subTotal = planAmount * result.seats;
            } else {
                console.log('user is doing a post-expiry payment for his current subscription');
                result.seats = user.TOTAL_SEATS_PURCHASED;
                result.planStartDate = currentDate.getTime()
                result.planEndDate = currentDate.setMonth(currentDate.getMonth() + planDuration);
                result.billingDays = Math.ceil((result.planEndDate - result.planStartDate) / 1000 / 3600 / 24);
                result.INR.subTotal = planDuration * planAmount * result.seats;
            }
        }

        if (result.INR.subTotal) {
            result.INR.tax = result.INR.subTotal * config.get('GST_PERCENTAGE');
            result.INR.total = result.INR.tax + result.INR.subTotal;
        }

        result = vm.convertCurrency(result, 'USD');

        result.INR.subTotal = result.INR.subTotal.toFixed(2);
        result.INR.tax = result.INR.tax.toFixed(2);
        result.INR.planAmount = result.INR.planAmount.toFixed(2);

        let total = parseFloat(result.INR.subTotal) + parseFloat(result.INR.tax);
        result.INR.total = total.toFixed(2);

        result.USD.subTotal = result.USD.subTotal.toFixed(2);
        result.USD.tax = result.USD.tax.toFixed(2);
        result.USD.planAmount = result.USD.planAmount.toFixed(2);

        total = parseFloat(result.USD.subTotal) + parseFloat(result.USD.tax);
        result.USD.total = total.toFixed(2);

        return result;
    }

    vm.convertCurrency = function(result, currency) {
        result[currency] = {};

        for (var key in result.INR)
            result[currency][key] = result.INR[key] / config.get('DOLLAR_CONVERSION');

        result[currency].planAmount = result.INR.planAmount / config.get('DOLLAR_CONVERSION');

        return result;
    }

    vm.daysInMonth = function(month, year) {
        return new Date(year, month, 0).getDate();
    }

    vm.lastDateOfCurrentMonth = function(date) {
        return (new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime() -
            (date.getTimezoneOffset() * 60000) - 1000); //minus one second ==> will end at 11:59:59 at night
    }

    vm.lastDateOfNextMonth = function(date) {
        return (new Date(date.getFullYear(), date.getMonth() + 2, 1).getTime() -
            (date.getTimezoneOffset() * 60000) - 1000); //minus one second ==> will end at 11:59:59 at night
    }

    vm.firstDateOfNextMonth = function(date) {
        return (new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime() -
            (date.getTimezoneOffset() * 60000) + 1000); //minus one second ==> will end at 11:59:59 at night
    }

    vm.isAnnotateByFreelancer = function(request) {
        var promise = new Promise((resolve, reject) => {
            var user = request.auth.credentials.admin ? request.auth.credentials.admin : request.auth.credentials.user;

            db.collection(config.get('USER_COLLECTION')).findOne({
                _id: new mongo.ObjectID(user._id.toString())
            }, function(err, result) {
                if (err)
                    reject(err)

                else if (result) {
                    if (result.PROJECTS[request.payload.projectId] && result.PROJECTS[request.payload.projectId].ANNOTATE_BY === 'freelancer')
                        resolve(true);

                    else
                        resolve(false);
                } else
                    resolve(false);
            });
        });

        return promise;
    }

    vm.changeFreelancerProjectStatus = function(queryBy, updateData) {
        var promise = new Promise((resolve, reject) => {
            db.collection(config.get('USER_COLLECTION')).updateOne(queryBy, updateData, function(err, res) {
                if (err)
                    reject(err);

                else if (res)
                    resolve(null);

                else
                    reject('Error occured while updating project details!')
            });
        });

        return promise;
    }

    // Send mail to freelancer and project owner after changing project status
    vm.sendMailForFreelancerProject = function(projectOwner, freelancer, newProjectStatus) {
        var promise = new Promise((resolve, reject) => {
            var mailTemplateForOwner;
            var mailTemplateForFreelancer;

            if (newProjectStatus === 'ACTIVE') { // Send training completed mails
                mailTemplateForOwner = 'EMAIL_TRAINING_COMPLETED_TO_OWNER';
                mailTemplateForFreelancer = 'EMAIL_TRAINING_COMPLETED_TO_FREELANCER';
            } else if (newProjectStatus === 'COMPLETED') { // Send project completed mails
                mailTemplateForOwner = 'EMAIL_PROJECT_COMPLETED_TO_OWNER';
                mailTemplateForFreelancer = 'EMAIL_PROJECT_COMPLETED_TO_FREELANCER';
            }

            var template_subs = {
                project_owner_name: projectOwner.NAME
            };

            vm.sendTemplateEmail(config.get('NEW_INVITE_EMAIL'), projectOwner.EMAIL_ID, config.get(mailTemplateForOwner)['SUBJECT'], template_subs, config.get(mailTemplateForOwner)['TEMPLATE_ID'], function(err, response) {
                if (err)
                    reject(err);

                else {
                    console.log('Mail sent to project owner ' + projectOwner.EMAIL_ID);
                    var template_subs = {
                        freelancer_name: freelancer.NAME
                    };

                    vm.sendTemplateEmail(config.get('NEW_INVITE_EMAIL'), freelancer.EMAIL_ID, config.get(mailTemplateForFreelancer)['SUBJECT'], template_subs, config.get(mailTemplateForFreelancer)['TEMPLATE_ID'], function(err, response) {
                        if (err)
                            reject(err);

                        else {
                            console.log('Mail sent to freelancer ' + freelancer.EMAIL_ID);
                            resolve(null);
                        }
                    });
                }
            });
        });

        return promise;
    }

    vm.freelancerProjectCost = function(user, projectId, shapeWiseCountFromOwnerEstimates, done) {

        console.log(arguments);

        var finalOutput = {};
        var classifiedImages = [];
        var unclassifiedImagesCount = 0;
        var labelsCount = 0;

        _async.parallel([
            function(callback) {
                db.collection(config.get('CLASSIFIED_OBJECT_COLLECTION')).find({
                    PROJECT_ID: projectId,
                    USER_OID: new mongo.ObjectID(user._id.toString())
                }).toArray(function(err, images) {
                    if (err)
                        callback(err);

                    else {
                        classifiedImages = images;
                        callback(null);
                    }
                });
            },
            function(callback) {
                db.collection(config.get('IMAGES_COLLECTION')).count({
                    PROJECT_ID: projectId,
                    USER_OID: new mongo.ObjectID(user._id.toString()),
                    STATUS: {
                        $ne: 'CLASSIFIED'
                    }
                }, function(err, count) {
                    if (err)
                        callback(err);

                    else {
                        unclassifiedImagesCount = count;
                        callback(null);
                    }
                });
            },
            function(callback) {
                db.collection(config.get('LABEL_COLLECTION')).count({
                    PROJECT_ID: projectId,
                    USER_OID: new mongo.ObjectID(user._id.toString())
                }, function(err, count) {
                    if (err)
                        callback(err);

                    else {
                        labelsCount = count;
                        callback(null);
                    }
                });
            }
        ], function(err) {
            if (err)
                done(err);

            else {
                console.log('classifiedImages count', classifiedImages.length);
                console.log('unclassifiedImages count', unclassifiedImagesCount);
                console.log('labels count', labelsCount);

                var shapeWiseCountFromAlreadyClassifiedImages = {};
                var shapes = ['RECTANGLE', 'POLYGON', 'CIRCLE', 'POINT', 'CUBOID'];

                //all shapes count initialized to zero
                shapes.forEach((shape) => {
                    shapeWiseCountFromAlreadyClassifiedImages[shape] = 0;
                    finalOutput[shape] = 0;
                });

                classifiedImages.forEach((image) => {
                    console.log(image);
                    console.log('image.LABEL_DETAILS.length', image.LABEL_DETAILS.length);

                    image.LABEL_DETAILS && image.LABEL_DETAILS.forEach((label) => {
                        if (label.EDGES_RECT && shapeWiseCountFromAlreadyClassifiedImages.RECTANGLE < label.EDGES_RECT.length)
                            shapeWiseCountFromAlreadyClassifiedImages.RECTANGLE = label.EDGES_RECT.length;

                        if (label.EDGES_POLY && shapeWiseCountFromAlreadyClassifiedImages.POLYGON < label.EDGES_POLY.length)
                            shapeWiseCountFromAlreadyClassifiedImages.POLYGON = label.EDGES_POLY.length;

                        if (label.EDGES_CIRCLE && shapeWiseCountFromAlreadyClassifiedImages.CIRCLE < label.EDGES_CIRCLE.length)
                            shapeWiseCountFromAlreadyClassifiedImages.CIRCLE = label.EDGES_CIRCLE.length;

                        if (label.EDGES_POINT && shapeWiseCountFromAlreadyClassifiedImages.POINT < label.EDGES_POINT.length)
                            shapeWiseCountFromAlreadyClassifiedImages.POINT = label.EDGES_POINT.length;

                        if (label.EDGES_CUBOID && shapeWiseCountFromAlreadyClassifiedImages.CUBOID < label.EDGES_CUBOID.length)
                            shapeWiseCountFromAlreadyClassifiedImages.CUBOID = label.EDGES_CUBOID.length;
                    });
                });

                var subTotal = 0;

                shapes.forEach((shape) => {
                    var maxCount = Math.max(shapeWiseCountFromAlreadyClassifiedImages[shape], shapeWiseCountFromOwnerEstimates[shape]);
                    var price = maxCount * config.get('FREELANCER_PRICING')[shape].OWNER_PAYS * unclassifiedImagesCount * labelsCount;
                    subTotal += price;

                    finalOutput[shape] = {
                        ownerEstimate: shapeWiseCountFromOwnerEstimates[shape],
                        projectEstimate: shapeWiseCountFromAlreadyClassifiedImages[shape],
                        maxCount,
                        USD: {
                            subTotal: '$ ' + (price / config.get('DOLLAR_CONVERSION')).toFixed(2)
                        },
                        INR: {
                            subTotal: 'Rs. ' + price.toFixed(2)
                        }
                    }
                });

                finalOutput.USD = {};
                finalOutput.INR = {};

                finalOutput.INR.subTotal = subTotal;
                finalOutput.INR.tax = finalOutput.INR.subTotal * config.get('GST_PERCENTAGE');
                finalOutput.INR.total = finalOutput.INR.subTotal + finalOutput.INR.tax;
                finalOutput.INR.unclassifiedImagesCount = unclassifiedImagesCount;
                finalOutput.INR.labelsCount = labelsCount;

                finalOutput.USD.subTotal = subTotal / config.get('DOLLAR_CONVERSION');
                finalOutput.USD.tax = finalOutput.USD.subTotal * config.get('GST_PERCENTAGE');
                finalOutput.USD.total = finalOutput.USD.subTotal + finalOutput.USD.tax;
                finalOutput.USD.unclassifiedImagesCount = unclassifiedImagesCount;
                finalOutput.USD.labelsCount = labelsCount;

                done(null, finalOutput);
            }
        });
    }

    vm.ifFileIsMedia = function(fileName) {
        var index = fileName.lastIndexOf('.');
        var extension = fileName.substring(index + 1).toLowerCase();
        var result = config.get('IMAGE_MIME_TYPE')[extension] ? true : false;

        console.log('checking', { fileName, extension, result });

        return result
    }

    return vm;
}
