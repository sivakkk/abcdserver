module.exports = function(service, messageLimiter) {
    var config = require('../config/config')();
    var _async = require('async');
    var mongo = require('mongodb');
    var db = config.getDB();

    this.getProjectLists = function(request, h){
        var data = [];
        var promise = new Promise((resolve, reject)=> {

            if(request.headers.user_id && request.headers.api_key) {
            if(messageLimiter.consumeSync(request.headers.api_key) == true){

                _async.waterfall([
                    function(callback){
                        db.collection(config.get('USER_COLLECTION')).updateOne({
                            _id: new mongo.ObjectID(request.headers.user_id),
                            API_KEY: request.headers.api_key
                        },
                        {
                            $inc : { "API_COUNT" : 1 }
                        }, function (err, res) {
                            if(err) service.handleError(reject, err);
                            else {
                                callback(null);
                            }
                        });
                    },
                    function(callback){
                        db.collection(config.get('USER_COLLECTION')).findOne({
                            _id: new mongo.ObjectID(request.headers.user_id),
                            API_KEY: request.headers.api_key
                        }, function(err, res){
                            if(err) service.handleError(reject, err);
                            else if(res === null) service.handleError(reject, 'No records found');
                            else {
                                if(res.PROJECTS){
                                    for(project in res.PROJECTS){
                                        data.push({"PROJECT_ID" : project, "NAME" : res.PROJECTS[project].NAME})
                                    }
                                    callback(null, data)
                                }
                            }
                        });
                    }
                ], function(err, results){
                    if(err) service.handleError(reject, err)
                    else
                        resolve(results)
                })

            } else {
                service.handleError(reject,'Rate Limit Exceeded','', statusCode = 429, );
            }}else {
                service.handleError(reject, 'Please provide a user_id and api_key in headers')
            }
        });

        return promise;
    }

    this.getProject = function(request, h) {
        var data = {}

        var promise = new Promise((resolve, reject) => {

            if(request.headers.api_key && request.headers.user_id && request.headers.project_id){

            if(messageLimiter.consumeSync(request.headers.api_key) == true) {
                _async.waterfall([
                    function(callback) {
                        db.collection(config.get('USER_COLLECTION')).updateOne({
                            _id: new mongo.ObjectID(request.headers.user_id),
                            API_KEY: request.headers.api_key
                        },
                        {
                            $inc : { "API_COUNT" : 1 }
                        }, function (err, res) {
                            if(err) service.handleError(reject, err);
                            else {
                                callback(null);
                            }
                        });
                    },
                    function (callback){
                            db.collection(config.get('USER_COLLECTION')).findOne({
                                API_KEY: request.headers.api_key,
                                _id: new mongo.ObjectID(request.headers.user_id)
                            }, function(err, res) {
                                if (err) service.handleError(reject, err);
                                else if(res == null) service.handleError(reject, 'No record found');
                                else {
                                    data = {...res.PROJECTS[request.headers.project_id]}
                                    data.PROJECT_ID = request.headers.project_id;
                                    // data.CONNECTED_ACCOUNT = res.EMAIL_ID;
                                    if(res.PROJECTS[request.headers.project_id].STORAGE_DETAILS.GOOGLE_DRIVE){
                                        data.CONNECTED_ACCOUNT = res.PROJECTS[request.headers.project_id].STORAGE_DETAILS.GOOGLE_DRIVE.CONNECTED_ACCOUNT
                                        data.FOLDER_NAME = res.PROJECTS[request.headers.project_id].STORAGE_DETAILS.GOOGLE_DRIVE.FOLDER_NAME
                                        data.LAST_CONNECTED = res.PROJECTS[request.headers.project_id].STORAGE_DETAILS.GOOGLE_DRIVE.LAST_CONNECTED_AT
                                    }

                                    callback(null, data);
                                }
                            });
                    },
                    function(projectData, callback) {
                        db.collection(config.get('IMAGES_COLLECTION')).count({
                            PROJECT_ID : request.headers.project_id,
                            USER_OID: request.headers.user_id
                        }, function(err, res){
                            if(err) service.handleError(reject, err)
                            else{
                                projectData.TOTAL_IMAGES = res
                                callback(null, projectData);
                            }
                        });
                    },
                    function(projectData, callback) {
                        db.collection(config.get('CLASSIFIED_OBJECT_COLLECTION')).count({
                            PROJECT_ID : request.headers.project_id,
                            USER_OID: request.headers.user_id
                        }, function(err, res){
                            if(err) service.handleError(reject, err)
                            else{
                                projectData.CLASSIFIED_IMAGES = res
                                callback(null, projectData);
                            }
                        });
                    }
                ], function(err, results){
                    if(err) service.handleError(reject, err);
                    else{
                        resolve(results)
                    }
                })
            }else {
                service.handleError(reject, 'Rate Limit Exceeded', '', statusCode = 429);
            }
        }else {
            service.handleError(reject, 'Provide a user_id and api_key in headers');
        }
        })

        return promise;
    }

    return this;

}
