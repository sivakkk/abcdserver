module.exports = function(service, gfs, io) {
    var config = require('../config/config')();
    var uuid = require('uuid/v1');
    var _async = require('async');
    var _request = require('request');
    var useragent = require('useragent');
    var mongo = require('mongodb');
    var fs = require('fs');
    var path = require('path');
    var Razorpay = require('razorpay');
    var db = config.getDB();

    var razorpay = new Razorpay({
          key_id: config.get('RAZOR_PAY').KEY_ID,
          key_secret: config.get('RAZOR_PAY').SECRET_KEY
      });

    var webhookEvents = {
        'invoice.paid' : invoicePaidHandler,
        'PAYMENT.CAPTURE.DENIED' : paymentDeniedHandler
    }

    this.webhookAuthMiddleware = function (request, h) {
        var promise = new Promise((resolve, reject) => {

            var rawBody = request.payload;
            var body = JSON.parse(request.payload.toString('utf8'));

            console.log(body);

            if(webhookEvents[body.event]) {
                if(Razorpay.validateWebhookSignature(rawBody, request.headers['xrazorpaysignature'], config.get('RAZOR_PAY').WEBHOOK_SECRET)) {
                    console.log('Webhook Signature matched');

                    webhookEvents[body.event](resolve, reject, body);
                }
                else
                    service.handleError(reject, 'Webhook Signature doesn\'t match for ' + body.event);
            }

            else {
                console.log('No handler for', body.event);

                resolve({ message : 'done' });
            }
        });

        return promise;
    }

    function invoicePaidHandler(resolve, reject, body) {
        console.log('Invoice Paid Webhook occured');

        _async.parallel([
            function (callback) {
                console.log('Storing Payment for', body.payload.invoice.entity.customer_details.email);

                db.collection(config.get('PAYMENT_COLLECTION')).insertOne({
                    EMAIL_ID : body.payload.invoice.entity.customer_details.email.toLowerCase(),
                    PAYMENT : body
                }, function (err) {
                    if(err)
                        callback(err);

                    else {
                        console.log('Webhook', body.event, 'Payment Added');

                        callback(null);
                    }
                });
            },
            function (callback) {
                db.collection(config.get('USER_COLLECTION')).findOne({
                    EMAIL_ID : body.payload.invoice.entity.customer_details.email.toLowerCase()
                }, function (err, user) {
                    if(err)
                        callback(err);

                    else {
                        var currentEndDate = new Date(user.PLAN_END_DATE)
                        var newEndDate;

                        if(currentEndDate.getMonth == 11)
	                        newEndDate = new Date(currentEndDate.getFullYear() + 1, 0, currentEndDate.getDate(), currentEndDate.getHours(), currentEndDate.getMinutes(), currentEndDate.getSeconds());

                        else
	                        newEndDate = new Date(currentEndDate.getFullYear(), currentEndDate.getMonth() + 1, currentEndDate.getDate(), currentEndDate.getHours(), currentEndDate.getMinutes(), currentEndDate.getSeconds());

                        callback(null, newEndDate);
                    }
                });
            },
            function (newEndDate, callback) {
                console.log('Turning FAILED_PAYMENT flag false for', body.payload.invoice.entity.customer_details.email);

                db.collection(config.get('USER_COLLECTION')).updateOne({
                    EMAIL_ID : body.payload.invoice.entity.customer_details.email.toLowerCase()
                }, {
                    $set : {
                        PLAN_END_DATE: newEndDate.getTime()
                    }
                }, function (err, result) {
                    if(err)
                        callback(err);

                    else {
                        console.log('Webhook', body.event, result.result.n, 'records updated');

                        callback(null);
                    }
                });
            }
        ], function (err) {
            if(err)
                service.handleError(reject, err);

            else
                resolve({ message : 'done' });
        });
    }

    function paymentDeniedHandler(resolve, reject, body) {
        console.log('Payment Failed Webhook occured');

        db.collection(config.get('USER_COLLECTION')).updateOne({
            EMAIL_ID : body.payload.payment.entity.email.toLowerCase()
        }, {
            $set : {
                FAILED_PAYMENT : true
            }
        }, function (err, result) {
            if(err)
                service.handleError(reject, err);

            else {
                console.log('Webhook', body.event, result.result.n, 'records updated');

                resolve({ message : 'done' });
            }
        });
    }

    return this;
}
