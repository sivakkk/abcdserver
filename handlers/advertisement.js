module.exports = function (service) {
    var config = require('../config/config')();
    var _async = require('async');
    var mongo = require('mongodb');
    var db = config.getDB();

    this.getMarketingFlyers = function(request, h) {
        var promise = new Promise((resolve, reject) => {

            _async.waterfall([
                function(callback) {
                    //  Search Global ad
                    db.collection(config.get('ADVT_DETAILS_COLLECTION')).find({
                        ADVT_DISPLAY_ROUTE: request.query.route,
                        ADVT_RUN_STATUS: 'ACTIVE',
                        ADVT_GLOBAL: true
                    }).toArray(function(err, results) {
                        if (err)
                            callback(err);

                        else
                            callback(null, results);
                    })
                },
                function(globalAds, callback) {
                    //  If no GLOBAL advt found, search advt By target userID
                    if (request.query.user !== '') {
                        db.collection(config.get('ADVT_DETAILS_COLLECTION')).find({
                            ADVT_DISPLAY_ROUTE: request.query.route,
                            ADVT_RUN_STATUS: 'ACTIVE',
                            ADVT_TARGET_USER_OID: new mongo.ObjectId(request.query.user),
                        }).toArray(function(err, results) {
                            if (err)
                                callback(err)

                            else {
                                allAds = globalAds.concat(results);
                                callback(null, allAds);
                            }
                        })
                    }

                    else
                        callback(null, globalAds);
                },
                function(ads, callback) {
                    //  Check If the Ads are already shown to current user
                    if (request.query.user !== '' && ads.length !== 0) {
                        var adIds = ads.map(ad => ad._id)

                        db.collection(config.get('ADVT_LOGS_COLLECTION')).find({
                            USER_OID: new mongo.ObjectId(request.query.user),
                            ADVT_OID: { $in: adIds }
                        }).toArray(function(err, results) {
                            if (err)
                                callback(err)

                            else {
                                var newAds;
                                var resultAdIds = results.map(ad => ad.ADVT_OID.toString())

                                newAds = ads.filter(element => resultAdIds.indexOf(element._id.toString()) === -1);

                                callback(null, newAds);
                            }
                        })
                    }

                    else
                        callback(null, ads);
                }
            ],
                function(err, ad_details) {
                    if (err)
                        service.handleError(reject, err);

                    else if (ad_details.length !== 0)
                        resolve({isAdAvailable: true, ad_details: ad_details});

                    else
                        resolve({isAdAvailable: false});
            });
        });

        return promise;
    }


    this.saveMarketingFlyersLogs = function(request, h) {
        var promise = new Promise((resolve, reject) => {

            db.collection(config.get('ADVT_LOGS_COLLECTION')).insertOne({
                USER_OID: new mongo.ObjectId(request.auth.credentials.user._id),
                ADVT_OID: new mongo.ObjectId(request.payload.ADVT_OID),
                ADVT_DISPLAYED_START_DATE: request.payload.ADVT_DISPLAYED_START_DATE,
                ADVT_DISPLAYED_END_DATE: request.payload.ADVT_DISPLAYED_END_DATE,
                ADVT_DISPLAYED_DURATION: request.payload.ADVT_DISPLAYED_DURATION,
                ADVT_CLICKED_STATUS: request.payload.ADVT_CLICKED_STATUS,
                ADVT_CLICKED_DATE: request.payload.ADVT_CLICKED_DATE
            }, function(err, res) {
                if (err)
                    service.handleError(reject, err);

                else {
                    console.log(res.insertedCount + ' log added for ad ' + request.payload.ADVT_OID);
                    resolve({success: true});
                }
            })
        });

        return promise;
    }


    return this;
}
