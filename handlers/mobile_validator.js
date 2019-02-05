module.exports = function(service) {
    var config = require('../config/config')();
    var uuid = require('uuid/v1');
    var _async = require('async');
    var randomstring = require('randomstring');
    var fs = require('fs');
    var bcrypt = require('bcrypt-nodejs');
    var mongo = require('mongodb');
    var db = config.getDB();

    this.mobileSignupHandler = function(request, h) {
        console.log('inside mobile validator',request.payload);
        var promise = new Promise((resolve, reject) => {
            var newUser = {
                EMAIL_ID: request.payload.email.toLowerCase(),
                PASSWORD: service.generateHash(request.payload.password),
                NAME: request.payload.name,
                VERIFIED: false,
                USER_TYPE: request.payload.type,
                FAILED_PAYMENT: false,
                IS_MARKETING_ENABLE: true,
                ACCOUNT_CREATED_ON: new Date().getTime(),
                SESSION_COUNT: 0,
                BANK_DETAILS: {
                    ACCOUNT_NO: request.payload.account_no,
                    IFSC: request.payload.ifsc,
                    ACCOUNT_NAME: request.payload.account_name
                },
                API_KEY: uuid()
              };


              _async.waterfall([
                  function(callback){
                      db.collection(config.get('USER_COLLECTION')).findOne({
                          EMAIL_ID: request.payload.email,
                          USER_TYPE: request.payload.user_type
                      }, function(err, user) {
                          if(err) service.handleError(err, reject);
                          else if(user) callback(request.payload.email + ' email is already taken.');
                          else if(request.payload.password !== request.payload.confirm_password) callback('Your passwords do not match');
                          else callback(null);
                      });
                  },
                  function(callback){
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
                  function (callback) {
                    console.log(newUser)
                    db.collection(config.get('USER_COLLECTION')).insertOne(newUser, function (err, docsInserted) {
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
    };

    this.mobileLoginHandler = function(request, h) {
        var promise = new Promise((resolve, reject) => {

            var rememberMe = request.payload.rememberMe || false;


            if(request.auth.isAuthenticated) {
                resolve({
                    redirect: '/profile'
                })
            } else {
                var query = {
                    EMAIL_ID: request.payload.email.toLowerCase(),
                    USER_TYPE: 'validator'
                };

                db.collection(config.get('USER_COLLECTION')).findOne(query, function(err, user) {
                    if(err) service.handleError(err, reject);
                    else if (!user || !bcrypt.compareSync(request.payload.password, user.PASSWORD))
                        service.handleError(reject, 'Incorrect username, password or user type', 400);
                    else if (!user.VERIFIED) {
                        resolve({
                            user: user,
                            redirect: '/verify-email'
                        });
                    }
                    else{
                        var sid = uuid();
                        var last_login = new Date().getTime()

                        _async.parallel([
                            function(callback) {
                                db.collection(config.get('USER_COLLECTION')).updateOne(query, {
                                    $set: {
                                        AUTH_TOKEN: sid,
                                        LAST_LOGGED_IN: last_login,
                                        LAST_LOGGED_IN_IP: request.payload.ipDetails.query
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
                            }
                        ], function(err, callback) {
                            if(err) service.handleError(err);
                            else {
                                user.AUTH_TOKEN = sid;
                                user.LAST_LOGGED_IN = new Date().getTime();
                                delete user.PASSWORD;
                                delete user.PROJECTS;

                                request.cookieAuth.set({
                                    sid,
                                    user
                                });

                                request.auth.isAuthenticated = true;

                                request.server.app.cache.set(sid, {
                                    user
                                }, 0);

                                if (rememberMe)
                                    request.cookieAuth.ttl(30 * 24 * 60 * 60 * 1000);
                                else
                                    request.cookieAuth.ttl(3 * 24 * 60 * 60 * 1000);

                                resolve ({
                                    user:user,
                                    redirect: '/profile'
                                })
                            }
                        })
                    }

                })
            }
        });

        return promise;
    }

    this.mobileVerifyHandler = function(request, h) {
        var promise = new Promise((resolve, reject) => {

            var body = request.payload;
            console.log(body)
            _async.waterfall([
              function (callback) {
                db.collection(config.get('USER_COLLECTION')).findOne({
                  PERMALINK: body.permalink,
                  USER_TYPE: body.userType
                }, function (err, user) {
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
              function (callback) {
                const successfn = function (err, resp) {
                  if (err) {
                    console.error(err);
                    callback('Error while verifying the user.');
                  } else {
                    console.log('The user has been verified!');

                    callback(null);
                  }
                };
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
            ], function (err) {
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

    this.mobileChangeDetailsHandler = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            console.log(request.payload.details);

            var user = {
                EMAIL_ID: request.payload.details.email_id,
                UPI_ID: request.payload.details.upi,
                PHONE: request.payload.details.phone,
                NAME: request.payload.details.name,
                ADDRESS: request.payload.details.address
            };

            db.collection(config.get('USER_COLLECTION')).updateOne(
                {
                    EMAIL_ID: request.payload.details.email_id,
                    USER_TYPE: config.get('USER_TYPE').VALIDATOR.NAME
                },
                { $set: user },
                {
                    upsert: true
                },
                function(err, res) {
                    if(err) callback(err, reject);
                    else if(res) resolve({
                        redirect: '/profile'
                    });
                }
            );
        });

        return promise;
    }

    this.mobileChangePasswordHandler = function(request, h){
        var promise = new Promise((resolve, reject) => {

            if(request.payload.new_password === request.payload.confirm_new_password){
                _async.waterfall([
                    function(callback){
                        db.collection(config.get('USER_COLLECTION')).findOne({
                            EMAIL_ID: request.payload.email_id,
                            USER_TYPE: config.get('USER_TYPE').VALIDATOR.NAME
                        }, function(err, res) {
                            console.log(bcrypt.compareSync(request.payload.password, res.PASSWORD));
                            if(err) service.handleError(err,reject);
                            else if(!bcrypt.compareSync(request.payload.password, res.PASSWORD)){
                                service.handleError(reject, "Your password isn't correct");
                            }
                            else if(res !== null && bcrypt.compareSync(request.payload.password, res.PASSWORD)){
                                console.log(bcrypt.compareSync(request.payload.password, res.PASSWORD));
                                callback(null);
                            }
                        });
                    },
                    function(callback){
                        db.collection(config.get('USER_COLLECTION')).updateOne(
                            {
                                EMAIL_ID: request.payload.email_id,
                                USER_TYPE: config.get('USER_TYPE').VALIDATOR.NAME
                            },
                            {
                                $set : {
                                    PASSWORD: service.generateHash(request.payload.new_password)
                                }
                            },
                            function(err, res) {
                                if(err) service.handleError(err, reject);
                                else {
                                    resolve({
                                        message: "done"
                                    });
                                }
                            }
                        )
                    }
                ])

            }

        });

        return promise;
    }

    return this;
}
