module.exports = function (service) {
    var config = require('../config/config')();
    var legalesign = require('legalesign')(config.get('LEGALESIGN').API_USERNAME, config.get('LEGALESIGN').API_KEY);
    var _this = this;
    var mongo = require('mongodb');
    var _async = require('async');
    var _request = require('request');
    var db = config.getDB();

    this.esignHandler = function (request, reply) {
        var document = {
            name: "Test",
            group: "carabiners",
            templatepdf: config.get('LEGALESIGN').TEMPLATE_PDF_ID,
            signers: [{
                firstname: request.payload.NAME,
                lastname: "Kumar",
                email: request.payload.EMAIL_ID.toLowerCase(),
                order: 0
            }],
            pdftext: {
                firstname: request.payload.NAME
            },
            signers_in_order: true,
            do_email: true
        };
        var promise = new Promise((resolve, reject) => {
            legalesign.send(document, function (err, result) {
                if (err) {
                    service.handleError(reject, err);
                } else {
                    return resolve(result);
                }
            });
        });
        return promise;
    }
    return this;
}
