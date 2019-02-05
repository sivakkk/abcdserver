module.exports = function(service) {
    var config = require('../config/config')();
    var _async = require('async');
    var mongo = require('mongodb');
    var db = config.getDB();

    this.getLabelsHandler = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            db.collection(config.get('LABEL_COLLECTION')).find({
                USER_OID: new mongo.ObjectID(request.auth.credentials.admin ? request.auth.credentials.admin._id : request.auth.credentials.user._id),
                PROJECT_ID: request.query.projectId
            }).toArray(function(err, labels) {
                if (err)
                    service.handleError(reject, err);

                else
                    resolve(labels);
            });
        });

        return promise;
    }

    this.deleteLabelsHandler = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            db.collection(config.get('LABEL_COLLECTION')).remove({
                _id: new mongo.ObjectID(request.params._id)
            }, function(err, res) {
                if (err)
                    service.handleError(reject, err);

                else if (res.result.n == 0)
                    service.handleError(reject, 'Label Not Found');

                else
                    resolve({
                        message: 'done'
                    });
            });
        });

        return promise;
    }

    this.postLabelsHandler = function(request, h) {
        var body = request.payload;

        var promise = new Promise((resolve, reject) => {
            db.collection(config.get('LABEL_COLLECTION')).updateOne({
                USER_OID: new mongo.ObjectID(request.auth.credentials.user._id),
                PROJECT_ID: body.projectId,
                LABEL_NAME: body.label.LABEL_NAME,
                LABEL_CATEGORY: body.label.LABEL_CATEGORY
            }, {
                $set: {
                    LABEL_NAME: body.label.LABEL_NAME,
                    LABEL_CATEGORY: body.label.LABEL_CATEGORY,
                    LABEL_COLOR: body.label.LABEL_COLOR,
                    LABEL_LAST_EDITED_DATE: new Date().getTime()
                },
                $setOnInsert: {
                    USER_OID: new mongo.ObjectID(request.auth.credentials.user._id),
                    PROJECT_ID: body.projectId,
                    LABEL_ADDED_DATE: new Date().getTime()
                }
            }, {
                upsert: true
            }, function(err, res) {
                if (err)
                    service.handleError(reject, err);

                else
                    resolve({
                        _id: res.upsertedId ? res.upsertedId._id : body._id
                    });
            });
        });

        return promise;
    }

    return this;
}
