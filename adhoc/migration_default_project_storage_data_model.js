var mongo = require('mongodb');
var MongoClient = mongo.MongoClient;
var PROD_DB = 'mongodb://ec2-18-195-12-247.eu-central-1.compute.amazonaws.com:27017/oclavi';
var LOCAL_DB = 'mongodb://local:7c7d79b1-c6cc-4933-b51b-346f18dd8bff@ds235708.mlab.com:35708/oclavi';

var DATA_MODEL = {
    "STORAGE_DATA": {
        "S3": {
            "ACCESS_KEY": "",
            "BUCKET_NAME": "",
            "SECRET_KEY": "",
            "REGION_NAME": ""
        },
        "GCP": {},
        "GOOGLE_DRIVE": {},
        "ONE_DRIVE": {},
        "AZURE_STORAGE": {
            "CONNECTION_STRING": "",
            "SHARE_NAME": "",
            "DIRECTORY_NAME": "",
            "CONTAINER_NAME": "",
            "BLOB_NAME": "",
            "AZURE_STORAGE_TYPES": ""
        }
    }
}
var DATABASE_URL = PROD_DB;
var COLLECTION_NAME = 'users';
var config = require('../config/config')();
var db;

var projectCount = 0;
var userCount = 0;

MongoClient.connect(DATABASE_URL, function(err, _db) {
    if (err)
        console.error(err);

    else {
        console.log('Connected to Mongo Server');

        db = _db;

        start();
    }
});

function start() {
    db.collection(COLLECTION_NAME).find({
        $and: [{
            USER_TYPE: {
                $ne: 'team'
            }
        }, {
            USER_TYPE: {
                $ne: 'freelancer'
            }
        }, {
            USER_TYPE: {
                $ne: 'validator'
            }
        }]
    }).toArray(function(err, docs) {
        if (err)
            console.error(err);

        else {
            var bulk = db.collection(COLLECTION_NAME).initializeUnorderedBulkOp();

            docs.forEach(user => {
                var flag = false;

                for (var key in user.PROJECTS) {
                    var activeStorage = user.PROJECTS[key].ACTIVE_STORAGE;

                    if (Object.keys(user.PROJECTS[key].STORAGE_DETAILS).length == 0) {
                        console.log(user._id, 'for project', key);
                        flag = true;

                        projectCount++;
                        user.PROJECTS[key].STORAGE_DETAILS = {
                            [activeStorage]: DATA_MODEL.STORAGE_DATA[activeStorage]
                        }
                    }
                }

                if(flag) {
                    userCount++;
                    // console.log(user);
                }

                bulk.find({
                    _id: new mongo.ObjectID(user._id.toString())
                }).update({
                    $set: user
                });
            });

            bulk.execute(function (err, res) {
                if (err)
                    console.error(err);

                else
                    console.log(JSON.stringify(res));
            });

            console.log({projectCount, userCount});
        }
    });
}
