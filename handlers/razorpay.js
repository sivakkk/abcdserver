module.exports = function(service) {
    var config = require('../config/config')();
    var Razorpay = require('razorpay');
    var _async = require('async');
    var mongo = require('mongodb');
    var db = config.getDB();

    var instance = new Razorpay({
        key_id: config.get('RAZOR_PAY').KEY_ID,
        key_secret: config.get('RAZOR_PAY').SECRET_KEY
    });

    var context = {
        capturePayment: function(payment_id, template_subs, callback) {
            console.log('razorpay capturePayment called');
            console.log(payment_id);

            _async.waterfall([
                function(waterfallCallback) {
                    //we need to cross validate the amount with the one store in the database
                    db.collection(config.get('PAYMENT_COLLECTION')).findOne({
                        'PAYMENT_CREATE_RESPONSE.PAYMENT_ID': payment_id,
                        PAYMENT_SOURCE: 'RAZOR_PAY'
                    }, function(err, payment) {
                        if (err)
                            waterfallCallback(err);

                        else if (!payment)
                            waterfallCallback('No associated payment');

                        else {
                            template_subs.oclavi_payment_id = payment.PAYMENT_CREATE_RESPONSE.PAYMENT_ID;
                            waterfallCallback(null, payment.PAYMENT_CREATE_RESPONSE.PAYMENT_ID, payment.PAYMENT_CREATE_RESPONSE.AMOUNT);
                        }
                    });
                },
                function(payment_id, amount, waterfallCallback) {
                    console.log(payment_id, amount);

                    instance.payments.capture(payment_id, amount, function(err, paymentResponse) {
                        if (err)
                            waterfallCallback(err);

                        else {
                            console.log("Razorpay Payment Execute Response");
                            console.log(paymentResponse);

                            template_subs.oclavi_payment_id = paymentResponse.id;
                            template_subs.oclavi_payment_source = 'Razorpay';
                            template_subs.oclavi_total_amount = paymentResponse.amount / 100;
                            template_subs.oclavi_sub_total = (paymentResponse.amount / 100) / (1 + config.get('GST_PERCENTAGE'));
                            template_subs.oclavi_tax = template_subs.oclavi_total_amount - template_subs.oclavi_sub_total;

                            template_subs.oclavi_total_amount = paymentResponse.currency + ' ' + template_subs.oclavi_total_amount.toFixed(2);
                            template_subs.oclavi_sub_total = paymentResponse.currency + ' ' + template_subs.oclavi_sub_total.toFixed(2);
                            template_subs.oclavi_tax = paymentResponse.currency + ' ' + template_subs.oclavi_tax.toFixed(2);

                            waterfallCallback(null, paymentResponse);
                        }
                    });
                },
                function(paymentResponse, waterfallCallback) {
                    db.collection(config.get('PAYMENT_COLLECTION')).findAndModify({
                        'PAYMENT_CREATE_RESPONSE.PAYMENT_ID': payment_id,
                        PAYMENT_SOURCE: 'RAZOR_PAY'
                    }, {}, {
                        $set: {
                            PAYMENT_EXECUTE_RESPONSE: paymentResponse,
                            STATUS: 'ACTIVE',
                            EXECUTE_DATE: (new Date()).getTime()
                        }
                    }, function(err, item) {
                        if (err)
                            waterfallCallback(err);

                        else {
                            console.log('item');
                            console.log(item);
                            waterfallCallback(null, item.value);
                        }
                    });
                }
            ], function(err, payment) {
                if (err)
                    callback(err);

                else
                    callback(null, payment);
            });
        },

        getModalData: function(request) {
            let body = request.payload;
            let user = request.auth.credentials.user;
            let seats = 0;
            let description;
            let planAmount, billingAmount;

            var promise = new Promise(function(resolve, reject) {
                console.log(body);

                _async.waterfall([
                    function(callback) {
                        if (body.type == 'buyMoreSeats') {
                            planAmount = service.getPlanForSeat(user.EMAIL_ID, user.TOTAL_SEATS_PURCHASED + parseInt(body.seats));
                            billingAmount = service.getBillingAmount(user, planAmount, null, parseInt(body.seats), true);
                            description = 'Buying ' + body.seats + ' more seats for Admin Plan';

                            callback(null, billingAmount);
                        } else if (body.type == 'upgrade') {
                            var limits = user.USER_TYPE == config.get('USER_TYPE').STUDENT_ADMIN.NAME ? config.get('USER_TYPE').STUDENT_ADMIN : config.get('USER_TYPE').STUDENT_SELF;

                            planAmount = service.getPlanForSeat(user.EMAIL_ID, limits.SUBSCRIPTION_FLAG.LIMITS.SEAT_LIMIT);
                            billingAmount = service.getBillingAmount(user, planAmount, body.planDuration, limits.SUBSCRIPTION_FLAG.LIMITS.SEAT_LIMIT, false);
                            description = 'Upgrading your account to Admin User';

                            callback(null, billingAmount);
                        } else if (body.type == 'freelancer') {
                            service.freelancerProjectCost(user, body.projectId, body.ownerEstimates, callback);
                            description = 'Making payment for freelancer';
                        } else {
                            callback('Unknown Payment Type');
                        }
                    }
                ], function(err, billingAmount) {
                    if (err)
                        service.handleError(reject, err);

                    else {
                        console.log(billingAmount);

                        var data = {
                            KEY: config.get('RAZOR_PAY').KEY_ID,
                            AMOUNT: parseInt(billingAmount.INR.total * 100).toString(),
                            MERCHANT_NAME: 'Carabiner Technologies',
                            DESCRIPTION: description,
                            NAME: user.EMAIL_ID,
                            EMAIL_ID: user.EMAIL_ID
                        }

                        resolve(data);
                    }
                })
            });

            return promise;
        },

        markPaymentAsFailed: function(user, queryParams, resolve, reject) {
            //queryParams contains ==>> token, paymentId, PayerID

            db.collection(config.get('PAYMENT_COLLECTION')).updateOne({
                USER_OID: new mongo.ObjectID(user._id.toString()),
                PAYMENT_ID: queryParams.razorpay_payment_id
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
