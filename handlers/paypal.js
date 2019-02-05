module.exports = function(service) {
    var config = require('../config/config')();
    var instance = require('paypal-rest-sdk');
    var _async = require('async');
    var url = require('url');
    var mongo = require('mongodb');
    var db = config.getDB();

    instance.configure({
        mode: config.get('PAYPAL').MODE, //sandbox or live
        client_id: config.get('PAYPAL').CLIENT_ID,
        client_secret: config.get('PAYPAL').SECRET_KEY
    });

    var context = {
        upgradeCreatePayment: function(user, paymentDetails, planDuration, callback) {
            var seats = 0;
            var paymentRequest = JSON.parse(JSON.stringify(config.get('PAYPAL_ONE_TIME_PAYMENT')));

            paymentRequest.redirect_urls.cancel_url += '/upgrade';
            paymentRequest.redirect_urls.return_url += '/upgrade';

            if (user.USER_TYPE == config.get('USER_TYPE').STUDENT_ADMIN.NAME) {
                seats = config.get('USER_TYPE').STUDENT_ADMIN.SUBSCRIPTION_FLAG.LIMITS.SEAT_LIMIT;

                paymentRequest.transactions[0].description = 'Admin Account plan for ' + seats + ' seats';
            } else if (user.USER_TYPE == config.get('USER_TYPE').STUDENT_SELF.NAME) {
                paymentRequest.transactions[0].description = 'Self Account plan';
            }

            let planAmount = service.getPlanForSeat(user.EMAIL_ID, seats);

            console.log('planAmount');
            console.log(planAmount);

            let billingAmount = service.getBillingAmount(user, planAmount, planDuration);

            console.log('billingAmount');
            console.log(billingAmount);

            paymentRequest.transactions[0].amount.total = billingAmount.USD.total;
            paymentRequest.transactions[0].amount.details.subtotal = billingAmount.USD.subTotal;
            paymentRequest.transactions[0].amount.details.tax = billingAmount.USD.tax;

            paymentDetails.PLAN_START_DATE = billingAmount.planStartDate;
            paymentDetails.PLAN_END_DATE = billingAmount.planEndDate;
            paymentDetails.BILLING_DAYS = billingAmount.billingDays;

            var paymentRequest = JSON.parse(JSON.stringify(config.get('PAYPAL_ONE_TIME_PAYMENT')));

            paymentRequest.redirect_urls.cancel_url += '/upgrade';
            paymentRequest.redirect_urls.return_url += '/upgrade';

            paymentRequest.transactions[0].amount.details.subtotal = billingAmount.USD.subTotal;
            paymentRequest.transactions[0].amount.details.tax = billingAmount.USD.tax;
            paymentRequest.transactions[0].amount.total = billingAmount.USD.total;

            if (user.USER_TYPE == config.get('USER_TYPE').STUDENT_ADMIN.NAME)
                paymentRequest.transactions[0].description = 'Upgrading your account to Admin User';

            else
                paymentRequest.transactions[0].description = 'Upgrading your account to Self User';

            console.log(JSON.stringify(paymentRequest, null, 2));

            instance.payment.create(paymentRequest, function(err, paymentResponse) {
                // console.log(err.response.details);
                console.log(paymentResponse);

                if (err)
                    callback(err.response.details);

                else {
                    console.log('Payment created successfully');
                    console.log(paymentResponse);

                    var approval_url;

                    for (var index = 0; index < paymentResponse.links.length; index++) {
                        if (paymentResponse.links[index].rel === 'approval_url') {
                            approval_url = paymentResponse.links[index].href;

                            console.log('approval_url :', approval_url);

                            break;
                        }
                    }

                    paymentDetails.PAYMENT_CREATE_RESPONSE = paymentResponse;
                    paymentDetails.PAYMENT_TOKEN = url.parse(approval_url, true).query.token;
                    paymentDetails.STATUS = 'CREATED';

                    callback(null, paymentResponse, approval_url);
                }
            });
        },

        buyMoreSeatsCreatePayment: function(user, seatsToBePurchased, paymentDetails, callback) {
            let planAmount = service.getPlanForSeat(user.EMAIL_ID, user.TOTAL_SEATS_PURCHASED + seatsToBePurchased);
            let billingAmount = service.getBillingAmount(user, planAmount, null, seatsToBePurchased, true);

            console.log('planAmount');
            console.log(planAmount);

            console.log('billingAmount');
            console.log(billingAmount);

            paymentDetails.PLAN_START_DATE = billingAmount.planStartDate;
            paymentDetails.PLAN_END_DATE = billingAmount.planEndDate;
            paymentDetails.BILLING_DAYS = billingAmount.billingDays;
            paymentDetails.PAYMENT_SOURCE = 'PAYPAL';

            _async.waterfall([
                function(waterfallCallback) {
                    var paymentRequest = JSON.parse(JSON.stringify(config.get('PAYPAL_ONE_TIME_PAYMENT')));

                    paymentRequest.redirect_urls.cancel_url += '/buyMoreSeats';
                    paymentRequest.redirect_urls.return_url += '/buyMoreSeats';
                    paymentRequest.transactions[0].description = 'Buying ' + seatsToBePurchased + ' more seats for Admin Plan';
                    paymentRequest.transactions[0].amount.total = billingAmount.USD.total;
                    paymentRequest.transactions[0].amount.details.subtotal = billingAmount.USD.subTotal;
                    paymentRequest.transactions[0].amount.details.tax = billingAmount.USD.tax;

                    instance.payment.create(paymentRequest, function(err, paymentResponse) {
                        if (err)
                            waterfallCallback(err.response);

                        else {
                            console.log('Payment created successfully');
                            console.log(paymentResponse);

                            var approval_url;

                            for (var index = 0; index < paymentResponse.links.length; index++) {
                                if (paymentResponse.links[index].rel === 'approval_url') {
                                    approval_url = paymentResponse.links[index].href;

                                    console.log('approval_url :', approval_url);

                                    break;
                                }
                            }

                            waterfallCallback(null, paymentResponse, approval_url);
                        }
                    });
                }
            ], function(err, paymentResponse, approval_url) {
                if (err)
                    callback(err);

                else {
                    paymentDetails.PAYMENT_CREATE_RESPONSE = paymentResponse;
                    paymentDetails.PAYMENT_TOKEN = url.parse(approval_url, true).query.token;
                    paymentDetails.STATUS = 'CREATED';

                    callback(err, paymentResponse, approval_url);
                }
            });
        },

        freelancerPayment: function(user, projectId, ownerEstimates, paymentDetails, callback) {
            let billingAmount;

            _async.waterfall([
                function(waterfallCallback) {
                    service.freelancerProjectCost(user, projectId, ownerEstimates, waterfallCallback);
                },
                function(billingAmount, waterfallCallback) {
                    console.log('billingAmount');
                    console.log(billingAmount);

                    var paymentRequest = JSON.parse(JSON.stringify(config.get('PAYPAL_ONE_TIME_PAYMENT')));

                    paymentRequest.redirect_urls.cancel_url += '/freelancer';
                    paymentRequest.redirect_urls.return_url += '/freelancer';
                    paymentRequest.transactions[0].description = 'Making payment for freelancer';
                    paymentRequest.transactions[0].amount.total = billingAmount.USD.total;
                    paymentRequest.transactions[0].amount.details.subtotal = billingAmount.USD.subTotal;
                    paymentRequest.transactions[0].amount.details.tax = billingAmount.USD.tax;

                    instance.payment.create(paymentRequest, function(err, paymentResponse) {
                        if (err)
                            waterfallCallback(err.response);

                        else {
                            console.log('Payment created successfully');
                            console.log(paymentResponse);

                            var approval_url;

                            for (var index = 0; index < paymentResponse.links.length; index++) {
                                if (paymentResponse.links[index].rel === 'approval_url') {
                                    approval_url = paymentResponse.links[index].href;

                                    console.log('approval_url :', approval_url);

                                    break;
                                }
                            }

                            waterfallCallback(null, paymentResponse, approval_url);
                        }
                    });
                }
            ], function(err, paymentResponse, approval_url) {
                if (err)
                    callback(err);

                else {
                    paymentDetails.PAYMENT_CREATE_RESPONSE = paymentResponse;
                    paymentDetails.PAYMENT_TOKEN = url.parse(approval_url, true).query.token;
                    paymentDetails.STATUS = 'CREATED';

                    callback(err, paymentResponse, approval_url);
                }
            });
        },

        executePayment: function(user, paymentId, payer_id, template_subs, callback) {
            _async.waterfall([
                function(waterfallCallback) {
                    instance.payment.execute(paymentId, {
                        payer_id
                    }, function(err, paymentResponse) {
                        if (err)
                            waterfallCallback(err);

                        else {
                            console.log("Paypal Payment Execute Response");
                            console.log(JSON.stringify(paymentResponse, null, 2));

                            template_subs.oclavi_payment_id = paymentResponse.id;
                            template_subs.oclavi_payment_source = 'Paypal';
                            template_subs.oclavi_total_amount = paymentResponse.transactions[0].amount.total;
                            template_subs.oclavi_sub_total = paymentResponse.transactions[0].amount.total / (1 + config.get('GST_PERCENTAGE'));
                            template_subs.oclavi_tax = template_subs.oclavi_total_amount - template_subs.oclavi_sub_total;

                            template_subs.oclavi_total_amount = paymentResponse.transactions[0].amount.currency + ' ' + parseFloat(template_subs.oclavi_total_amount).toFixed(2);
                            template_subs.oclavi_sub_total = paymentResponse.transactions[0].amount.currency + ' ' + parseFloat(template_subs.oclavi_sub_total).toFixed(2);
                            template_subs.oclavi_tax = paymentResponse.transactions[0].amount.currency + ' ' + parseFloat(template_subs.oclavi_tax).toFixed(2);

                            waterfallCallback(null, paymentResponse);
                        }
                    });
                },
                function(paymentExecuteResponse, waterfallCallback) {
                    db.collection(config.get('PAYMENT_COLLECTION')).findAndModify({
                        USER_OID: new mongo.ObjectID(user._id.toString()),
                        'PAYMENT_CREATE_RESPONSE.id': paymentId
                    }, {}, {
                        $set: {
                            PAYMENT_EXECUTE_RESPONSE: paymentExecuteResponse,
                            STATUS: 'ACTIVE',
                            EXECUTE_DATE: (new Date()).getTime()
                        }
                    }, function(err, item) {
                        if (err)
                            waterfallCallback(err);

                        else
                            waterfallCallback(null, item.value);
                    });
                }
            ], function(err, payment) {
                if (err)
                    callback(err);

                else
                    callback(null, payment);
            });
        },

        markPaymentAsFailed: function(user, queryParams, resolve, reject) {
            //queryParams contains ==>> token, paymentId, PayerID

            db.collection(config.get('PAYMENT_COLLECTION')).updateOne({
                USER_OID: new mongo.ObjectID(user._id.toString()),
                PAYMENT_TOKEN: queryParams.token
            }, {
                $set: {
                    STATUS: 'FAILED'
                }
            }, function(err, result) {
                if (err)
                    service.handleError(reject, err);

                else {
                    resolve({
                        message: 'done'
                    });
                }
            });
        }
    }

    return context;
}
