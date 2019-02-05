module.exports = function(service) {
    var config = require('../config/config')();
    var paypal = require('./paypal')(service);
    var razorpay = require('./razorpay')(service);
    var _async = require('async');
    var mongo = require('mongodb');
    var path = require('path');
    var url = require('url');
    var fs = require('fs');
    var db = config.getDB();

    var context = {
        getBillingAmount: function(request, h) {
            let body = request.payload;
            let planAmount, billingAmount;

            var promise = new Promise(function(resolve, reject) {
                console.log(body);

                _async.waterfall([
                    function(callback) {
                        if (body.type == 'buyMoreSeats') {
                            planAmount = service.getPlanForSeat(request.auth.credentials.user.EMAIL_ID, request.auth.credentials.user.TOTAL_SEATS_PURCHASED + parseInt(body.seats));
                            billingAmount = service.getBillingAmount(request.auth.credentials.user, planAmount, null, parseInt(body.seats), true);

                            callback(null, billingAmount);
                        } else if (body.type == 'upgrade') {
                            var limits = request.auth.credentials.user.USER_TYPE == config.get('USER_TYPE').STUDENT_ADMIN.NAME ? config.get('USER_TYPE').STUDENT_ADMIN : config.get('USER_TYPE').STUDENT_SELF;

                            planAmount = service.getPlanForSeat(request.auth.credentials.user.EMAIL_ID, limits.SUBSCRIPTION_FLAG.LIMITS.SEAT_LIMIT);
                            billingAmount = service.getBillingAmount(request.auth.credentials.user, planAmount, body.planDuration, limits.SUBSCRIPTION_FLAG.LIMITS.SEAT_LIMIT, false);

                            callback(null, billingAmount);
                        } else if (body.type == 'freelancer') {
                            service.freelancerProjectCost(request.auth.credentials.user, body.projectId, body.ownerEstimates, callback);
                        } else {
                            callback('Unknown Payment Type');
                        }
                    }
                ], function(err, billingAmount) {
                    if (err)
                        service.handleError(reject, err);

                    else {
                        console.log(billingAmount);

                        resolve(billingAmount);
                    }
                })
            });

            return promise;
        },

        getSubscriptionDetails: function(request, h) {
            var promise = new Promise((resolve, reject) => {
                var payments;

                db.collection(config.get('PAYMENT_COLLECTION')).find({
                    USER_OID: new mongo.ObjectID(request.auth.credentials.user._id.toString())
                }).sort({
                    _id: -1
                }).toArray(function(err, payments) {
                    if (err)
                        service.handleError(reject, err);

                    else {
                        payments = payments.map((payment) => {
                            var paymentExecuteResponse = payment.PAYMENT_EXECUTE_RESPONSE;

                            return {
                                payment_id: paymentExecuteResponse ? paymentExecuteResponse.id : '',
                                payment_state: paymentExecuteResponse ? (paymentExecuteResponse.state == '') ? paymentExecuteResponse.status : paymentExecuteResponse.state : '',
                                purpose: payment.PAYMENT_TYPE,
                                description: paymentExecuteResponse ? (payment.PAYMENT_SOURCE == 'RAZOR_PAY') ? payment.PAYMENT_TYPE : paymentExecuteResponse.transactions[0].description : '',
                                billing_date: payment.CREATE_DATE ? payment.CREATE_DATE : '',
                                plan_start_date: payment.PLAN_START_DATE ? payment.PLAN_START_DATE : '',
                                plan_end_date: payment.PLAN_END_DATE ? payment.PLAN_END_DATE : '',
                                paymentMethod: payment.PAYMENT_SOURCE ? payment.PAYMENT_SOURCE : 'PAYPAL',
                                paidBy: paymentExecuteResponse ? (paymentExecuteResponse.email == '') ? paymentExecuteResponse.payer.payer_info.email : paymentExecuteResponse.email : '',
                                regularAmount: {
                                    total_amount: paymentExecuteResponse ? (payment.PAYMENT_SOURCE == 'RAZOR_PAY') ? paymentExecuteResponse.amount : paymentExecuteResponse.transactions[0].amount.total : '',
                                    sub_total: paymentExecuteResponse ? (payment.PAYMENT_SOURCE == 'RAZOR_PAY') ? paymentExecuteResponse.amount - paymentExecuteResponse.tax : paymentExecuteResponse.transactions[0].amount.details.sub_total : '',
                                    tax: paymentExecuteResponse ? (payment.PAYMENT_SOURCE == 'RAZOR_PAY') ? paymentExecuteResponse.tax : paymentExecuteResponse.transactions[0].amount.details.tax : '',
                                    currency: paymentExecuteResponse ? (payment.PAYMENT_SOURCE == 'RAZOR_PAY') ? paymentExecuteResponse.currency : paymentExecuteResponse.transactions[0].amount.currency : ''
                                },
                                card_last4: paymentExecuteResponse ? (payment.PAYMENT_SOURCE == 'RAZOR_PAY') ? paymentExecuteResponse.card.last4 : paymentExecuteResponse.payer.payer_method : '',
                                billingDays: payment.BILLING_DAYS,
                                paymentStatus: payment.STATUS
                            }
                        });

                        resolve(payments);
                    }
                });
            });

            return promise;
        },

        cancelSubscription: function(request, h) {
            console.log('Cancelling subscription for', request.auth.credentials.user.USER_TYPE);

            var template_subs = {};

            var promise = new Promise((resolve, reject) => {
                var limits = request.auth.credentials.user.USER_TYPE == config.get('USER_TYPE').ADMIN.NAME ? config.get('USER_TYPE').STUDENT_ADMIN : config.get('USER_TYPE').STUDENT_SELF;

                if (request.auth.credentials.user.USER_TYPE != config.get('USER_TYPE').ADMIN.NAME && request.auth.credentials.user.USER_TYPE != config.get('USER_TYPE').SELF.NAME) {
                    service.handleError(reject, 'No Active Plan was found');
                    return;
                }

                _async.waterfall([
                    function(callback) {
                        //cancelling the subscription for creating a new subscription with more number of seats
                        db.collection(config.get('USER_COLLECTION')).count({
                            ADMIN_ID: new mongo.ObjectID(request.auth.credentials.user._id)
                        }, function(err, count) {
                            if (err)
                                callback(err);

                            else {
                                if (count > limits.SUBSCRIPTION_FLAG.LIMITS.SEAT_LIMIT)
                                    callback('You need to remove some of your team members.');

                                else
                                    callback(null);
                            }
                        });
                    },
                    function(callback) {
                        db.collection(config.get('PAYMENT_COLLECTION')).findAndModify({
                            USER_OID: new mongo.ObjectID(request.auth.credentials.user._id.toString()),
                            STATUS: 'ACTIVE',
                            PAYMENT_TYPE: 'UPGRADE'
                        }, {
                            DATE: -1
                        }, {
                            $set: {
                                STATUS: 'CANCELLED',
                                CANCELLED_DATE: (new Date()).getTime()
                            }
                        }, function(err, item) {
                            if (err)
                                callback(err);

                            else
                                callback(null, item.value);
                        });
                    },
                    function(payment, callback) {
                        console.log('Updating User Type and subscription for the user');
                        console.log(payment);

                        template_subs.oclavi_plan_end_date = new Date(payment.PLAN_END_DATE).toDateString();

                        db.collection(config.get('USER_COLLECTION')).updateOne({
                            _id: new mongo.ObjectID(request.auth.credentials.user._id.toString())
                        }, {
                            $set: {
                                STATUS: 'PENDING_FOR_CANCELLATION',
                            }
                        }, function(err, result) {
                            if (err)
                                callback(err);

                            else
                                callback(null);
                        });
                    },
                    function(callback) {
                        service.sendTemplateEmail(
                            config.get('NEW_INVITE_EMAIL'),
                            request.auth.credentials.user.EMAIL_ID,
                            config.get('EMAIL_PLAN_CANCELLATION').SUBJECT,
                            template_subs,
                            config.get('EMAIL_PLAN_CANCELLATION').TEMPLATE_ID,
                            function(err, response) {
                                err ? callback(err.response.body) : callback(null);
                            });
                    }
                ], function(err) {
                    if (err) {
                        console.error(err);
                        service.handleError(reject, 'Error cancelling the subscription');
                    } else {
                        resolve(request.auth.credentials.user);
                    }
                })

            });

            return promise;
        },

        markPaymentAsFailed: function(request, h) {
            console.log('Cancelling inactive subscription for', request.auth.credentials.user.USER_TYPE);

            var promise = new Promise((resolve, reject) => {
                let params = request.payload.params;
                let queryParams = request.payload.queryParams;

                if (params.source == 'paypal') {
                    paypal.markPaymentAsFailed(request.auth.credentials.user, queryParams, resolve, reject);
                } else if (params.source == 'razorpay') {
                    razorpay.markPaymentAsFailed(request.auth.credentials.user, queryParams, resolve, reject);
                } else
                    service.handleError(reject, 'Unknown payment source');
            });

            return promise;
        },

        upgradePaymentHandler: function(request, h) {
            console.log('Upgrading for', request.auth.credentials.user.USER_TYPE);
            console.log(request.payload);

            var promise = new Promise((resolve, reject) => {

                var paypal_redirect_url;
                var paymentDetails = {
                    USER_OID: new mongo.ObjectID(request.auth.credentials.user._id.toString()),
                    CREATE_DATE: (new Date()).getTime(),
                    PAYMENT_TYPE: 'UPGRADE',
                    PAYMENT_SOURCE: request.payload.PAYMENT_SOURCE
                };

                _async.waterfall([
                        function(callback) {
                            if (request.payload.PAYMENT_SOURCE == 'PAYPAL') {
                                paypal.upgradeCreatePayment(request.auth.credentials.user, paymentDetails, request.payload.planDuration, function(err, paymentResponse, approval_url) {
                                    if (err)
                                        callback(err.response);

                                    else {
                                        paypal_redirect_url = approval_url;
                                        callback(null);
                                    }
                                });
                            } else if (request.payload.PAYMENT_SOURCE == 'RAZOR_PAY') {
                                paymentDetails.PAYMENT_CREATE_RESPONSE = request.payload;
                                paymentDetails.PAYMENT_SOURCE = 'RAZOR_PAY';
                                paymentDetails.PLAN_START_DATE = request.payload.PLAN_START_DATE;
                                paymentDetails.PLAN_END_DATE = request.payload.PLAN_END_DATE;

                                callback(null);
                            } else
                                callback('Unknown Payment Gateway');
                        },
                        function(callback) {
                            db.collection(config.get('PAYMENT_COLLECTION')).insert(paymentDetails, function(err, result) {
                                if (err)
                                    callback(err);

                                else {
                                    console.log(result.result.n + ' records updated.');
                                    callback(null);
                                }
                            });
                        }
                    ],
                    function(err, approval_url) {
                        if (err)
                            service.handleError(reject, err);

                        else {
                            console.log('paypal_redirect_url', paypal_redirect_url);

                            if (paypal_redirect_url) {
                                resolve({
                                    approval_url: paypal_redirect_url
                                });
                            } else
                                resolve('done');
                        }
                    });
            });

            return promise;
        },

        upgradeExecutePaymentHandler: function(request, h) {
            console.log('paymentExecutePaymentHandler');
            console.log(request.payload);

            var template_subs = {};
            var newDetails = {};
            let params = request.payload.params;
            let queryParams = request.payload.queryParams;

            var promise = new Promise((resolve, reject) => {
                _async.waterfall([
                        function(callback) {
                            var fn = function(error, paymentExecuteResponse) {
                                if (error)
                                    callback(error);

                                else
                                    callback(null, paymentExecuteResponse);
                            }

                            if (params.source == 'paypal') {
                                paypal.executePayment(request.auth.credentials.user, queryParams.paymentId, queryParams.PayerID, template_subs, fn);
                            } else if (params.source == 'razorpay') {
                                razorpay.capturePayment(queryParams.razorpay_payment_id, template_subs, fn);
                            } else
                                callback(null, 'Unkown Payment Gateway');
                        },
                        function(payment, callback) {
                            console.log('findAndModify');
                            console.log(payment);

                            if (request.auth.credentials.user.USER_TYPE == config.get('USER_TYPE').STUDENT_ADMIN.NAME) {
                                newDetails.USER_TYPE = config.get('USER_TYPE').ADMIN.NAME;
                                newDetails.SUBSCRIPTION_FLAG = config.get('USER_TYPE').ADMIN.SUBSCRIPTION_FLAG;
                            } else if (request.auth.credentials.user.USER_TYPE == config.get('USER_TYPE').STUDENT_SELF.NAME) {
                                newDetails.USER_TYPE = config.get('USER_TYPE').SELF.NAME;
                                newDetails.SUBSCRIPTION_FLAG = config.get('USER_TYPE').SELF.SUBSCRIPTION_FLAG;
                            }

                            newDetails.PLAN_START_DATE = payment.PLAN_START_DATE;
                            newDetails.PLAN_END_DATE = payment.PLAN_END_DATE;

                            //update the changed fields in database
                            db.collection(config.get('USER_COLLECTION')).updateOne({
                                _id: new mongo.ObjectID(request.auth.credentials.user._id.toString())
                            }, {
                                $set: newDetails
                            }, function(err, result) {
                                if (err)
                                    callback(err);

                                else {
                                    console.log('upgradePlanVerifyPaymentHandler', result.result.n, 'records updated');

                                    var sessionUser = request.auth.credentials.user;
                                    sessionUser.SUBSCRIPTION_FLAG = newDetails.SUBSCRIPTION_FLAG;
                                    sessionUser.USER_TYPE = newDetails.USER_TYPE;
                                    sessionUser.PLAN_START_DATE = newDetails.PLAN_START_DATE;
                                    sessionUser.PLAN_END_DATE = newDetails.PLAN_END_DATE;

                                    service.changeSessionData(request, sessionUser, null);

                                    console.log('\n\n');
                                    console.log(request.auth.credentials.user);

                                    callback(null, payment);
                                }
                            });
                        },
                        function(payment, callback) {
                            service.sendTemplateEmail(
                                config.get('NEW_INVITE_EMAIL'),
                                request.auth.credentials.user.EMAIL_ID,
                                config.get('EMAIL_UPGRADE_PLAN').SUBJECT,
                                template_subs,
                                config.get('EMAIL_UPGRADE_PLAN').TEMPLATE_ID,
                                function(err, response) {
                                    if (err)
                                        console.log(err.response);

                                    err ? callback(err) : callback(null);
                                });
                        }
                    ],
                    function(err, result) {
                        if (err)
                            service.handleError(reject, err);

                        else
                            resolve(request.auth.credentials.user);
                    });
            });

            return promise;
        },

        paymentDetailsHandler: function(request, h) {
            var promise = new Promise((resolve, reject) => {
                db.collection(config.get('PAYMENT_COLLECTION')).find({
                    USER_OID: new mongo.ObjectID(request.auth.credentials.user._id.toString())
                }, {
                    _id: 0,
                    EMAIL_ID: 0
                }).toArray(function(err, items) {
                    if (err)
                        service.handleError(reject, 'Error fetching the payment details.');

                    else
                        resolve(items);
                });
            });

            return promise;
        },

        getRazorpayModalData: function(request, h) {
            return razorpay.getModalData(request);
        },

        storeRazorpayPayment: function(request, h) {
            return razorpay.storePayment(request, resolve, reject);
        },

        buyMoreSeatsHandler: function(request, h) {
            console.log('Buying', request.payload.seats, 'seats for', request.auth.credentials.user.USER_TYPE);

            var promise = new Promise((resolve, reject) => {
                if (request.auth.credentials.user.USER_TYPE == config.get('USER_TYPE').STUDENT_ADMIN.NAME || request.auth.credentials.user.USER_TYPE == config.get('USER_TYPE').STUDENT_SELF.NAME) {
                    service.handleError(reject, 'You are not allowed to buy more seats');
                    return;
                } else if (request.auth.credentials.user.PLAN_END_DATE < (new Date()).getTime()) {
                    service.handleError(reject, 'Your subscription has ended. Please upgrade');
                    return;
                }

                var limits = request.auth.credentials.user.USER_TYPE == config.get('USER_TYPE').ADMIN.NAME ? config.get('USER_TYPE').STUDENT_ADMIN : config.get('USER_TYPE').STUDENT_SELF;
                var paypal_redirect_url;

                var paymentDetails = {
                    USER_OID: new mongo.ObjectID(request.auth.credentials.user._id.toString()),
                    CREATE_DATE: (new Date()).getTime(),
                    PAYMENT_TYPE: 'BUY_MORE_SEATS',
                    PURCHASE_SEAT_REQUEST: request.payload.seats,
                    PAYMENT_SOURCE: request.payload.paymentSource
                };

                _async.waterfall([
                        function(callback) {
                            if (request.payload.PAYMENT_SOURCE == 'PAYPAL') {
                                paypal.buyMoreSeatsCreatePayment(request.auth.credentials.user, request.payload.seats, paymentDetails, function(err, paymentResponse, approval_url) {
                                    if (err)
                                        callback(err.response);

                                    else {
                                        paypal_redirect_url = approval_url;
                                        callback(null);
                                    }
                                });
                            } else if (request.payload.PAYMENT_SOURCE == 'RAZOR_PAY') {
                                paymentDetails.PAYMENT_CREATE_RESPONSE = request.payload;
                                paymentDetails.PAYMENT_SOURCE = 'RAZOR_PAY';

                                callback(null);
                            } else
                                callback('Unknown Payment Gateway');
                        },
                        function(callback) {
                            db.collection(config.get('PAYMENT_COLLECTION')).insert(paymentDetails, function(err, result) {
                                if (err)
                                    callback(err);

                                else {
                                    console.log(result.result.n + ' records updated.');
                                    callback(null);
                                }
                            });
                        }
                    ],
                    function(err) {
                        if (err)
                            service.handleError(reject, err);

                        else {
                            if (paypal_redirect_url) {
                                resolve({
                                    approval_url: paypal_redirect_url
                                });
                            } else
                                resolve('done');
                        }
                    });
            });

            return promise;
        },

        buyMoreSeatsExecutePaymentHandler: function(request, h) {
            console.log('buyMoreSeatsExecutePaymentHandler');

            var newDetails = {};
            let template_subs = {
                oclavi_username: request.auth.credentials.user.EMAIL_ID
            };
            let params = request.payload.params;
            let queryParams = request.payload.queryParams;

            console.log(params);
            console.log(queryParams);

            var promise = new Promise((resolve, reject) => {
                _async.waterfall([
                        function(callback) {
                            if (params.source == 'paypal') {
                                paypal.executePayment(request.auth.credentials.user, queryParams.paymentId, queryParams.PayerID, template_subs, function(error, payment) {
                                    if (error)
                                        callback(error);

                                    else
                                        callback(null, payment);
                                });
                            } else if (params.source == 'razorpay') {
                                razorpay.capturePayment(queryParams.razorpay_payment_id, template_subs, function(error, payment) {
                                    if (error)
                                        callback(error);

                                    else
                                        callback(null, payment);
                                });
                            } else
                                callback(null, 'Unkown Payment Gateway');
                        },
                        function(payment, callback) {
                            console.log('payment info after capture');
                            console.log(payment);

                            newDetails.TOTAL_SEATS_PURCHASED = payment.PURCHASE_SEAT_REQUEST + request.auth.credentials.user.TOTAL_SEATS_PURCHASED;
                            template_subs.oclavi_purchased_seats = payment.PURCHASE_SEAT_REQUEST.toString();

                            //update the changed fields in database
                            db.collection(config.get('USER_COLLECTION')).updateOne({
                                _id: new mongo.ObjectID(request.auth.credentials.user._id.toString())
                            }, {
                                $set: newDetails
                            }, function(err, result) {
                                if (err)
                                    callback(err);

                                else {
                                    console.log('upgradePlanVerifyPaymentHandler', result.result.n, 'records updated');

                                    callback(null);
                                }
                            });
                        },
                        function(callback) {
                            service.sendTemplateEmail(
                                config.get('NEW_INVITE_EMAIL'),
                                request.auth.credentials.user.EMAIL_ID,
                                config.get('EMAIL_BUY_MORE_SEATS').SUBJECT,
                                template_subs,
                                config.get('EMAIL_BUY_MORE_SEATS').TEMPLATE_ID,
                                function(err, response) {
                                    err ? callback(err.response.body) : callback(null);
                                });
                        }
                    ],
                    function(err, result) {
                        if (err)
                            service.handleError(reject, err);

                        else {
                            var sessionUser = request.auth.credentials.user;
                            sessionUser.TOTAL_SEATS_PURCHASED = newDetails.TOTAL_SEATS_PURCHASED;

                            service.changeSessionData(request, sessionUser, null);

                            resolve(request.auth.credentials.user);
                        }
                    });
            });

            return promise;
        },

        freelancerPaymentHandler: function(request, h) {
            console.log('Freelancer payment for project ', request.payload.PROJECT_ID);

            var promise = new Promise((resolve, reject) => {
                if (request.auth.credentials.user.USER_TYPE == config.get('USER_TYPE').STUDENT_ADMIN.NAME || request.auth.credentials.user.USER_TYPE == config.get('USER_TYPE').STUDENT_SELF.NAME) {
                    service.handleError(reject, 'You are not allowed to avail freelancers');
                    return;
                } else if (request.auth.credentials.user.PLAN_END_DATE < (new Date()).getTime()) {
                    service.handleError(reject, 'Your subscription has ended. Please upgrade');
                    return;
                }

                var paypal_redirect_url;
                var paymentDetails = {
                    USER_OID: new mongo.ObjectID(request.auth.credentials.user._id.toString()),
                    CREATE_DATE: (new Date()).getTime(),
                    PAYMENT_TYPE: 'FREELANCER',
                    PROJECT_ID: request.payload.PROJECT_ID,
                    OWNER_ESTIMATES: request.payload.OWNER_ESTIMATES,
                    PAYMENT_SOURCE: request.payload.PAYMENT_SOURCE
                };

                _async.waterfall([
                        function(callback) {
                            if (request.payload.PAYMENT_SOURCE == 'PAYPAL') {
                                paypal.freelancerPayment(request.auth.credentials.user, request.payload.PROJECT_ID, request.payload.OWNER_ESTIMATES, paymentDetails, function(err, paymentResponse, approval_url) {
                                    if (err)
                                        callback(err.response);

                                    else {
                                        paypal_redirect_url = approval_url;
                                        callback(null);
                                    }
                                });
                            } else if (request.payload.PAYMENT_SOURCE == 'RAZOR_PAY') {
                                paymentDetails.PAYMENT_CREATE_RESPONSE = request.payload;
                                paymentDetails.PAYMENT_SOURCE = 'RAZOR_PAY';

                                callback(null);
                            } else
                                callback('Unknown Payment Gateway');
                        },
                        function(callback) {
                            db.collection(config.get('PAYMENT_COLLECTION')).insert(paymentDetails, function(err, result) {
                                if (err)
                                    callback(err);

                                else {
                                    console.log(result.result.n + ' records updated.');
                                    callback(null);
                                }
                            });
                        }
                    ],
                    function(err) {
                        if (err)
                            service.handleError(reject, err);

                        else {
                            if (paypal_redirect_url) {
                                resolve({
                                    approval_url: paypal_redirect_url
                                });
                            } else
                                resolve('done');
                        }
                    });
            });

            return promise;
        },

        freelancerExecutePaymentHandler: function(request, h) {
            console.log('freelancerPaymentHandler');

            var newDetails = {};
            let params = request.payload.params;
            let queryParams = request.payload.queryParams;

            console.log(params);
            console.log(queryParams);

            var promise = new Promise((resolve, reject) => {
                _async.waterfall([
                        function(callback) {
                            if (params.source == 'paypal') {
                                paypal.executePayment(request.auth.credentials.user, queryParams.paymentId, queryParams.PayerID, template_subs, function(error, payment) {
                                    if (error)
                                        callback(error);

                                    else
                                        callback(null, payment);
                                });
                            } else if (params.source == 'razorpay') {
                                razorpay.capturePayment(queryParams.razorpay_payment_id, template_subs, function(error, payment) {
                                    if (error)
                                        callback(error);

                                    else
                                        callback(null, payment);
                                });
                            } else
                                callback(null, 'Unkown Payment Gateway');
                        },
                        function(payment, callback) {
                            console.log('payment info after capture');
                            console.log(payment);

                            newDetails['PROJECTS.' + payment.PROJECT_ID + '.PAYMENT_STATUS'] = 'DONE';
                            newDetails['PROJECTS.' + payment.PROJECT_ID + '.OWNER_ESTIMATES'] = payment.OWNER_ESTIMATES;

                            console.log('newDetails');
                            console.log(newDetails);

                            //update the changed fields in database
                            db.collection(config.get('USER_COLLECTION')).updateOne({
                                _id: new mongo.ObjectID(request.auth.credentials.user._id.toString())
                            }, {
                                $set: newDetails
                            }, function(err, result) {
                                if (err)
                                    callback(err);

                                else {
                                    console.log('freelancerPaymentExecuteHandler', result.result.n, 'records updated');

                                    callback(null);
                                }
                            });
                        }
                    ],
                    function(err, result) {
                        if (err)
                            service.handleError(reject, err);

                        else
                            resolve(request.auth.credentials.user);
                    });
            });

            return promise;
        }
    }

    return context;
}
