module.exports = function(service) {
    var config = require('../config/config')();
    var mongo = require('mongodb');
    var _async = require('async');
    var db = config.getDB();

    this.getTeamMembers = function(request, h) {
        var promise = new Promise((resolve, reject) => {
            results = {};
            var OIDS = new Array();
            _async.series([
                function(callback) {
                    db.collection(config.get('USER_COLLECTION')).aggregate([
                        {
                            $match: {
                                ADMIN_ID: new mongo.ObjectId(request.auth.credentials.user._id)
                            }
                        },
                        {
                            $lookup: {
                                from: 'classified_images',
                                localField: "_id",
                                foreignField: "USER_OID",
                                as: "CLASSIFIED_IMAGES"
                            }
                        },
                        {
                            "$addFields": {
                                "TOTAL_TIME_BY_USER": {
                                    "$reduce": {
                                        "input": "$CLASSIFIED_IMAGES",
                                        "initialValue": 0,
                                        "in": {
                                            "$add": ["$$value", "$$this.CLASSIFICATION_TOTAL_TIME"]
                                        }
                                    }
                                },
                                "TOTAL_IMAGES": {
                                    $size: "$CLASSIFIED_IMAGES"
                                }
                            }
                        },
                        {
                            "$project": {
                                "NAME": 1,
                                "TOTAL_IMAGES": 1,
                                "TOTAL_TIME_BY_USER": 1
                            }
                        },
                        {
                            "$group": {
                                "_id": null,
                                "documents": {
                                    $push: "$$ROOT"
                                },
                                "TOTAL_OBJECTS": {
                                    $sum: "$TOTAL_IMAGES"
                                },
                                "TOTAL_TIME": {
                                    $sum: "$TOTAL_TIME_BY_USER"
                                },
                                "users": {
                                    "$sum": 1
                                }
                            }
                        }
                    ],
                    function(err, result) {
                        if (err) {
                            service.handleError(reject, err);
                            callback(err);
                        } else {
                            // resolve(result);
                            results.users = result;
                            callback(null);
                        }
                    })
                },
                function(callback) {
                    db.collection(config.get('CLASSIFIED_OBJECT_COLLECTION')).aggregate([{
                            $match: {
                                "USER_OID": {
                                    $in: OIDS
                                }
                            }
                        },
                        {
                            $group: {
                                "_id": "$OBJECT_OID"
                            }
                        },
                        {
                            $count: "DISTINCT"
                        },
                    ], function(err, res) {
                        if (err) {
                            service.handleError(reject, err);
                        } else {
                            results.distinct = res;
                            callback(null);
                        }
                    });
                },
                function(callback) {
                    db.collection(config.get('IMAGES_COLLECTION')).aggregate([{
                            $match: {
                                "USER_OID": {
                                    $in: [new mongo.ObjectId(request.auth.credentials.user._id)]
                                }
                            }
                        },
                        {
                            $count: "TOTAL_IMAGES"
                        }
                    ], function(err, res) {
                        if (err) {
                            service.handleError(reject, err);
                        } else {
                            results.total_images = res;
                            callback(null);
                        }
                    })
                },
                function(callback) {
                    console.log('second', results);
                    if (results.total_images.length > 0) {
                        results.users[0].documents.map(user => {
                            OIDS.push(new mongo.ObjectId(user._id));
                        });
                        db.collection(config.get('CLASSIFIED_OBJECT_COLLECTION')).aggregate([{
                                $match: {
                                    "USER_OID": {
                                        $in: OIDS
                                    }
                                }
                            },
                            {
                                $project: {
                                    TIME: "$CLASSIFICATION_END_DATE"
                                }
                            },
                            {
                                $group: {
                                    _id: "$TIME",
                                    COUNT: {
                                        $sum: 1
                                    }
                                }
                            },
                            {
                                $sort: {
                                    _id: 1
                                }
                            }
                        ], function(err, res) {
                            if (err) {
                                service.handleError(reject, err);
                            } else {
                                results.teamData = res;
                                callback(null);
                            }
                        });
                    } else {
                        console.log('new user');
                        results.teamData = [];
                        callback(null);
                    }
                }
            ], function(err) {
                if (err)
                    service.handleError(reject, err);

                else
                    resolve(results);
            });
        });

        return promise;
    }

    return this;
}
