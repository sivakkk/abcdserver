const hapi = require('hapi');
const chalk = require('chalk');
const path = require('path');
const nconf = require('nconf');
const fs = require('fs');
const _async = require('async');
const mongo = require('mongodb');
const Joi = require('joi');
const socketIO = require('socket.io');
const Grid = require('gridfs-stream');
const namespace = require('hapijs-namespace');
const hapiBoomDecorators = require('hapi-boom-decorators');
const url = require('url');

const config = require('./config/config')();

var MongoClient = mongo.MongoClient;

var FastRateLimit = require('fast-ratelimit').FastRateLimit;

var messageLimiter = new FastRateLimit({
    threshold: 10,
    ttl: 60
})

var service, imageHandlers, accountHandlers, imageSettingHandlers, gdriveHandlers, webhookHandlers, dashboardHandlers, trainingHandlers, projectHandlers, freelancerHandlers, apiHandlers;
var onlineUsers = new Array();
var _io;

config.init(() => {
    var serverConfig = {
        host: '0.0.0.0',
        port: config.get('HTTP_PORT')
    };

    //cors is need only in the development environment
    if (config.get('CORS_URL')) {
        serverConfig.routes = {
            cors: {
                origin: config.get('CORS_URL'),
                credentials: true
            }
        }
    }

    const server = hapi.server(serverConfig);

    //registered boom error decorators
    server.register(hapiBoomDecorators);

    var db = config.getDB();
    var io = socketIO.listen(server.listener);

    gfs = Grid(db, mongo);
    service = require('./helper/service')();
    imageSettingHandlers = require('./handlers/image-settings')(service);
    synchronizer = require('./handlers/synchronizer_copy')(service, io);
    imageHandlers = require('./handlers/image')(synchronizer, service);
    trainingHandlers = require('./handlers/training')(service);
    labelsHandlers = require('./handlers/labels')(service);
    accountHandlers = require('./handlers/account')(service, gfs);
    projectHandlers = require('./handlers/project')(service, gfs);
    classifyHandlers = require('./handlers/classify')(service);
    passwordHandlers = require('./handlers/password')(service);
    paymentHandlers = require('./handlers/payments')(service);
    inviteUserHandlers = require('./handlers/invite-user')(service);
    signupHandlers = require('./handlers/signup')(service);
    loginHandlers = require('./handlers/login')(service);
    gdriveHandlers = require('./handlers/storages/gdrive')(service);
    dashboardHandlers = require('./handlers/dashboard')(service);
    viewImageHandlers = require('./handlers/view-image')(service);
    advertisementHandlers = require('./handlers/advertisement.js')(service);
    freelancerHandlers = require('./handlers/freelancer')(service);
    freelancerProjectHandlers = require('./handlers/freelancer-project.js')(service);
    esignHandlers = require('./handlers/esign')(service);
    apiHandlers = require('./handlers/api')(service, messageLimiter);
    webhookHandlers = require('./handlers/webhook')(service, io);
    validatorHandlers = require('./handlers/mobile_validator')(service);

    require('./helper/io')(io, service);
    _db = db;

    registerPlugins(server);
});

function registerPlugins(server) {
    server.register([require('hapi-auth-cookie'), require('inert')], {
        routes: {
            prefix: '/oapi'
        }
    }).then(function(err) {
        if (err)
            console.error(err);

        else {
            var cache = server.cache({
                segment: 'sessions',
                expiresIn: 3 * 24 * 60 * 60 * 1000
            });
            server.app.cache = cache;

            server.auth.strategy('session', 'cookie', {
                password: config.get('SESSION_PASSWORD'),
                isHttpOnly: true,
                isSameSite: false,
                isSecure: false,
                clearInvalid: true,
                validateFunc: (request, session, callback) => {
                    var promise = new Promise((resolve, reject) => {
                        if (session.user.AUTH_TOKEN) {
                            cache.get(session.sid, function(err, data) {
                                if (err)
                                    service.handleError(reject, err, 'Error while validating the session.');

                                else
                                    console.log('sid', data);
                            });

                            _db.collection(config.get('USER_COLLECTION')).findOne({
                                _id: new mongo.ObjectID(session.user._id.toString())
                            }, function(err, item) {
                                if (err)
                                    service.handleError(reject, err, 'Error while fetching the records.');

                                else if (session.user && session.user.AUTH_TOKEN && item.AUTH_TOKEN != session.user.AUTH_TOKEN) {
                                    console.log('AUTH_TOKEN mismatch', 'for', session.user.EMAIL_ID);
                                    console.log('in session', session.user.AUTH_TOKEN);
                                    console.log('in db', item.AUTH_TOKEN);

                                    resolve({
                                        valid: false
                                    });
                                } else
                                    resolve({
                                        valid: true
                                    });
                            });
                        } else {
                            console.log('session.user not present');

                            resolve({
                                valid: true
                            });
                        }
                    });

                    return promise;
                }
            });

            server.auth.default('session');

            registerRoutes(server);

            server.start(function(err) {
                console.log('info', 'Server running at: ' + server.info.uri);
            });
        }
    });
}

function registerRoutes(server) {
    namespace(server, '/oapi', [{
            method: 'GET',
            path: '/imageClassifiedCount',
            handler: imageHandlers.imageClassifiedCountHandler
        }, {
            method: 'GET',
            path: '/labels',
            handler: labelsHandlers.getLabelsHandler
        }, {
            method: 'DELETE',
            path: '/labels/{_id}',
            handler: labelsHandlers.deleteLabelsHandler
        }, {
            method: 'POST',
            path: '/labels',
            handler: labelsHandlers.postLabelsHandler
        }, {
            method: 'POST',
            path: '/saveImage',
            handler: imageHandlers.saveImageHandler
        }, {
            method: 'POST',
            path: '/skipImage',
            handler: imageHandlers.skipImageHandler
        }, {
            method: 'POST',
            path: '/updateClassifiedImage',
            handler: imageHandlers.updateClassifiedImageHandler
        }, {
            method: 'GET',
            path: '/subscriptionDetails',
            handler: paymentHandlers.getSubscriptionDetails
        }, {
            method: 'GET',
            path: '/getPlanPrice',
            config: {
                auth: false,
                handler: signupHandlers.getPlanPrice
            }
        }, {
            method: 'POST',
            path: '/cancelSubscription',
            handler: paymentHandlers.cancelSubscription
        }, {
            method: 'POST',
            path: '/markPaymentAsFailed',
            handler: paymentHandlers.markPaymentAsFailed
        }, {
            method: 'POST',
            path: '/freelancerPayment',
            handler: paymentHandlers.freelancerPaymentHandler
        }, {
            method: 'POST',
            path: '/freelancerExecutePayment',
            handler: paymentHandlers.freelancerExecutePaymentHandler
        }, {
            method: 'POST',
            path: '/export',
            handler: imageSettingHandlers.exportHandler
        }, {
            method: 'GET',
            path: '/synchronizer/{type}',
            handler: imageHandlers.synchronizerHandler
        }, {
            method: 'GET',
            path: '/progress/{objectId}',
            handler: imageHandlers.progressHandler
        }, {
            method: 'GET',
            path: '/nextImage/{id?}',
            handler: imageHandlers.nextImageHandler
        }, {
            method: 'GET',
            path: '/logout',
            handler: accountHandlers.logoutHandler
        }, {
            method: 'POST',
            path: '/confirmPassword',
            handler: accountHandlers.confirmPasswordHandler
        }, {
            method: 'POST',
            path: '/webhook',
            config: {
                auth: false,
                payload: {
                    output: 'data',
                    parse: false
                },
                handler: webhookHandlers.webhookAuthMiddleware
            }
        }, {
            method: 'POST',
            path: '/deleteAccount',
            handler: accountHandlers.deleteAccount
        }, {
            method: 'POST',
            path: '/accountSwitch',
            handler: accountHandlers.accountSwitch
        }, {
            method: 'POST',
            path: '/accountDowngrade',
            handler: accountHandlers.accountDowngrade
        }, {
            method: 'POST',
            path: '/savePhoneNumber',
            handler: accountHandlers.savePhoneNumber
        }, {
            method: 'POST',
            path: '/regenerateAPI_KEY',
            handler: accountHandlers.regenerateAPI_key
        }, {
            method: 'GET',
            path: '/invitedUsers',
            handler: inviteUserHandlers.getInvitedUsersHandler
        }, {
            method: 'POST',
            path: '/sendInvite',
            handler: inviteUserHandlers.sendInviteHandler
        }, {
            method: 'DELETE',
            path: '/deleteTeamUser/{_id}',
            handler: inviteUserHandlers.deleteTeamUserHandler
        }, {
            method: 'GET',
            path: '/projectInvitedUsers',
            handler: inviteUserHandlers.getProjectInvitedUsersHandler
        }, {
            method: 'POST',
            path: '/sendProjectInvite',
            handler: inviteUserHandlers.sendProjectInviteHandler
        }, {
            method: 'POST',
            path: '/removeProjectInvite',
            handler: inviteUserHandlers.removeProjectInviteUserHandler
        }, {
            method: 'POST',
            path: '/saveInvitedUserDetails',
            handler: inviteUserHandlers.saveInvitedUserDetailsHandler
        }, {
            method: 'POST',
            path: '/classify',
            handler: classifyHandlers.classifyHanlder
        }, {
            method: 'POST',
            path: '/training',
            handler: trainingHandlers.trainingImagesHandler
        }, {
            method: 'GET',
            path: '/schema',
            handler: imageHandlers.schemaHandler
        }, {
            method: 'POST',
            path: '/training/update',
            handler: trainingHandlers.updateCertificationHandler
        }, {
            method: 'POST',
            path: '/training/next',
            handler: trainingHandlers.getTrainingImageHandler
        }, {
            method: 'GET',
            path: '/paymentDetails',
            handler: paymentHandlers.paymentDetailsHandler
        }, {
            method: 'POST',
            path: '/admin-dashboard',
            handler: dashboardHandlers.getTeamMembers
        }, {
            method: 'POST',
            path: '/razorpay/getModalData',
            handler: paymentHandlers.getRazorpayModalData
        }, {
            method: 'GET',
            path: '/imageSettings',
            handler: imageSettingHandlers.imageSettingHandlers
        }, {
            method: 'POST',
            path: '/disconnectGoogleDrive',
            handler: imageSettingHandlers.disconnectGoogleDrive
        }, {
            method: 'POST',
            path: '/login',
            config: {
                auth: false,
                handler: loginHandlers.loginHandler
            }
        }, {
            method: 'GET',
            path: '/apiexport',
            config: {
                auth: false,
                handler: imageSettingHandlers.apiExportHandler
            }
        }, {
            method: 'POST',
            path: '/do/forgetpassword',
            config: {
                auth: false,
                handler: passwordHandlers.forgetPassword
            }
        }, {
            method: 'POST',
            path: '/verify/password-token',
            config: {
                auth: false,
                handler: passwordHandlers.verifyPasswordToken
            }
        }, {
            method: 'POST',
            path: '/reset-password',
            config: {
                auth: false,
                handler: passwordHandlers.resetPassword
            }
        }, {
            method: 'POST',
            path: '/signUp',
            config: {
                auth: false,
                handler: signupHandlers.signUpHandler
            }
        }, {
            method: 'POST',
            path: '/upgradeExecutePayment',
            handler: paymentHandlers.upgradeExecutePaymentHandler
        }, {
            method: 'POST',
            path: '/getBillingAmount',
            handler: paymentHandlers.getBillingAmount
        }, {
            method: 'POST',
            path: '/buyMoreSeats',
            handler: paymentHandlers.buyMoreSeatsHandler
        }, {
            method: 'POST',
            path: '/buyMoreSeatsExecutePayment',
            handler: paymentHandlers.buyMoreSeatsExecutePaymentHandler
        }, {
            method: 'POST',
            path: '/verify',
            config: {
                auth: false,
                handler: signupHandlers.verifyHandler
            }
        }, {
            method: 'POST',
            path: '/upload/avatar',
            config: {
                payload: {
                    output: 'stream',
                    parse: true,
                    allow: 'multipart/form-data'
                }
            },
            handler: accountHandlers.uploadAvatar
        }, {
            method: 'POST',
            path: '/esign',
            config: {
                auth: false,
                handler: esignHandlers.esignHandler
            }
        }, {

            method: 'POST',
            path: '/update/name',
            handler: accountHandlers.updateName
        }, {
            method: 'POST',
            path: '/update/password',
            handler: passwordHandlers.updatePassword
        }, {
            method: 'POST',
            path: '/connect/oclavi',
            config: {
                auth: false,
                handler: accountHandlers.connectUs
            }
        }, {
            method: 'GET',
            path: '/avatar/{_imageid}',
            config: {
                auth: false,
                handler: accountHandlers.getUserAvatar
            }
        }, {
            method: 'POST',
            path: '/upgradePlan',
            handler: paymentHandlers.upgradePaymentHandler
        }, {
            method: 'POST',
            path: '/regenerateExportToken',
            handler: imageSettingHandlers.regenerateExportTokenHandler
        }, {
            method: 'POST',
            path: '/imageSettings/update',
            handler: imageSettingHandlers.updateStorage
        }, {
            method: 'GET',
            path: '/image-settings.json',
            handler: function(request, h) {
                return config.get('UI_SCHEMA');
            }
        }, {
            method: 'GET',
            path: '/gdrive/auth',
            handler: gdriveHandlers.gdriveoAuth
        }, {
            method: 'POST',
            path: '/gdrive/callback',
            handler: gdriveHandlers.gdriveoAuthCallback
        }, {
            method: 'POST',
            path: '/gdrive/disconnect',
            handler: gdriveHandlers.disconnectDriveHandler
        }, {
            method: 'POST',
            path: '/gdrive/checkToken',
            handler: gdriveHandlers.checkToken
        }, {
            method: 'POST',
            path: '/freelancer/signup',
            config: {
                auth: false,
                handler: signupHandlers.freelancerSignup
            }
        }, {
            method: 'POST',
            path: '/freelancer/login',
            config: {
                auth: false,
                handler: loginHandlers.freelancerLogin
            }
        }, {
            method: 'POST',
            path: '/resend/verify-email',
            config: {
                auth: false,
                handler: service.resentVerificationMail
            }
        }, {
            method: 'GET',
            path: '/me/isAuthenticated',
            handler: service.isAlreadyAuthenticated
        }, {
            method: 'GET',
            path: '/project/getProjects',
            handler: projectHandlers.getProjects
        }, {
            method: 'POST',
            path: '/project/createProject',
            handler: projectHandlers.createProject
        }, {
            method: 'POST',
            path: '/project/editProject',
            handler: projectHandlers.editProject
        }, {
            method: 'POST',
            path: '/project/deleteProject',
            handler: projectHandlers.deleteProject
        }, {
            method: 'POST',
            path: '/project/cancelDeletion',
            handler: projectHandlers.cancelDeletion
        }, {
            method: 'POST',
            path: '/project/selectProjectFolder',
            handler: projectHandlers.selectProjectFolder
        }, {
            method: 'GET',
            path: '/viewImage/getImages',
            handler: viewImageHandlers.getImages
        }, {
            method: 'POST',
            path: '/viewImage/unlockImage',
            handler: viewImageHandlers.unlockImage
        }, {
            method: 'GET',
            path: '/viewImage/getImageDetails',
            handler: viewImageHandlers.getImageDetails
        }, {
            method: 'POST',
            path: '/project/addProjectReadInstructions',
            handler: projectHandlers.createProjectReadInstructions
        }, {
            method: 'GET',
            path: '/project/getProjectReadInstructions/{_projectId}',
            handler: projectHandlers.getProjectReadInstructions
        }, {
            method: 'GET',
            path: '/project/getProjectIdFromImage/{imageId}',
            handler: projectHandlers.getProjectIdFromImageHandler
        }, {
            method: 'POST',
            path: '/upload/readMeImg',
            config: {
                auth: false,
                handler: projectHandlers.uploadInstructionImg,
                payload: {
                    output: 'stream',
                    parse: true,
                    allow: 'multipart/form-data'
                }
            }
        }, {
            method: 'GET',
            path: '/instructionsImg/{_imageid}',
            config: {
                auth: false,
                handler: projectHandlers.getInstructionImg
            }
        }, {
            method: 'GET',
            path: '/getChannelVideos',
            config: {
                auth: false,
                handler: service.getChannelVideos
            }
        }, {
            method: 'GET',
            path: '/serverCheck',
            config: {
                auth: false,
                handler: service.serverCheck
            }
        }, {
            method: 'GET',
            path: '/me',
            handler: accountHandlers.me
        }, {
            method: 'POST',
            path: '/project/sendAcceptProjectLink',
            handler: projectHandlers.sendAcceptProjectLink
        }, {
            method: 'POST',
            path: '/freelancer/verifyPermalink',
            config: {
                auth: false,
                handler: freelancerProjectHandlers.verifyPermalinkFreelanceProject
            }
        }, {
            method: 'GET',
            path: '/freelancer/getProjects',
            handler: freelancerProjectHandlers.getFreelancerProjects
        }, {
            method: 'GET',
            path: '/freelancer/getClassifiedData/{objectId}',
            handler: imageHandlers.freelancerGetClassifiedData
        }, {
            method: 'POST',
            path: '/saveFreelancerTrainingImage',
            handler: imageHandlers.saveFreelancerTrainingImage
        }, {
            method: 'GET',
            path: '/getMarketingFlyers',
            config: {
                auth: false,
                handler: advertisementHandlers.getMarketingFlyers
            }
        }, {
            method: 'POST',
            path: '/saveMarketingFlyersLogs',
            handler: advertisementHandlers.saveMarketingFlyersLogs
        },
        {
            method: 'GET',
            path: '/v1/projects',
            config: {
                auth: false,
                handler: apiHandlers.getProjectLists
            }
        }, {
            method: 'GET',
            path: '/v1/project',
            config: {
                auth: false,
                handler: apiHandlers.getProject
            }
        }, {
            method: 'POST',
            path: '/mobile/login',
            config: {
                auth: false,
                handler: validatorHandlers.mobileLoginHandler
            }
        },
        {
            method: 'POST',
            path: '/mobile/signup',
            config: {
                auth: false,
                handler: validatorHandlers.mobileSignupHandler
            }
        },
        {
            method: 'POST',
            path: '/mobile/verify',
            config: {
                auth: false,
                handler: validatorHandlers.mobileVerifyHandler
            }
        },
        {
            method: 'POST',
            path: '/mobile/change-password',
            config: {
                handler: validatorHandlers.mobileChangePasswordHandler,
                auth: false
            }
        },
        {
            method: 'POST',
            path: '/mobile/change-account-details',
            config: {
                handler: validatorHandlers.mobileChangeDetailsHandler,
                auth: false
            }
        }
    ]);
}
