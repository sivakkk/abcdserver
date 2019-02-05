var mongo = require('mongodb');
var MongoClient = mongo.MongoClient;
var DATABASE_URL = 'mongodb://ec2-18-195-12-247.eu-central-1.compute.amazonaws.com:27017/oclavi';
var COLLECTION_NAME = 'users';
var db;

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
        PLAN_END_DATE: {
            $exists: true
        },
        PLAN_START_DATE: {
            $exists: false
        },
        ACCOUNT_CREATED_ON: {
            $exists: true
        },
    }).toArray(function(err, docs) {
        if (err)
            console.error(err);

        else {
            var bulk = db.collection(COLLECTION_NAME).initializeUnorderedBulkOp();

            docs.forEach(user => {
                bulk.find({
                    _id: new mongo.ObjectID(user._id.toString())
                }).update({
                    $set: {
                        PLAN_START_DATE: user.ACCOUNT_CREATED_ON
                    }
                });
            });

            bulk.execute(function(err, res) {
                if (err) {
                    console.log('error');
                    console.error(err);
                }

                else {
                    console.log('Successfully');
                    console.log(res.toJSON());
                }
            });
        }
    });
}
