module.exports = function(service) {
    var config = require('../config/config')();
    var _async = require('async');
    var mongo = require('mongodb');
    var db = config.getDB();

    this.classifyHanlder = function(request, dataObject) {
        var promise = new Promise((resolve, reject) => {
            if (request.auth.credentials.user.PLAN_END_DATE < (new Date()).getTime()) {
                service.handleError(reject, 'Your plan has ended. Please Upgrade.');
                return;
            }

            service.isAnnotateByFreelancer(request).then(canProceed => {
                var userType = request.auth.credentials.user.USER_TYPE;

                if ((userType == config.get('USER_TYPE').ADMIN.NAME || userType == config.get('USER_TYPE').STUDENT_ADMIN.NAME || userType == config.get('USER_TYPE').FREELANCER.NAME) && !canProceed)
                    service.handleError(reject, 'Only Self and Student Self users can avail this functionality.');

                else {
                    service.checkClassifiedImageCount(request).then(() => {
                        service.getImageForClassifyScreen(request, request.auth.credentials.user, request.auth.credentials.admin, request.payload.projectId, function (err, data) {
                            if(err)
                                service.handleError(reject, err, 'Error while fetching image.');

                            else {
                                resolve(data);
                            }
                        });
                    }).catch(err => service.handleError(reject, err));
                }
            }).catch(err => service.handleError(reject, err));

        });

        return promise;
    }

    return this;
}
