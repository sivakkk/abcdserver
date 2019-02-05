var mongo = require('mongodb');
var path = require('path');
var MongoClient = mongo.MongoClient;
var batch;


/**
 Edit DATABASE_URL and COLLECTION_NAME before running
 **/


var DATABASE_URL = 'mongodb://localhost:27017/oclavi';
var db, totalCount;

MongoClient.connect(DATABASE_URL, function(err, _db) {
    if (err)
        console.error(err);

    else {
        console.log('Connected to Mongo Server');

        db = _db;
        batch = db.collection('users').initializeUnorderedBulkOp();

        start();
    }
});

function start() {
    db.collection('users').find().toArray(function(err, docs) {
        if (err)
            console.error(err);

        else {
            // console.log(docs[0]);
            docs.forEach(function(doc, index) {
                var query = {};
                if(doc['PLAN_END_DATE']){
                    query['PLAN_END_DATE'] = new Date(doc.PLAN_END_DATE).getTime();
                }
                else {
                    query['PLAN_END_DATE'] = 1540166360000
                }


                batch.find({
                    _id: new mongo.ObjectID(doc._id.toString()),
                    USER_TYPE: {$in: ['self', 'admin']} 
                }).update({
                    $set: query
                }, {
                    upsert: true
                });
            });

            console.log('Executing the batch');

            batch.execute(function(err, res) {
                if (err)
                    console.error(err);

                else {
                    console.log('Update result');
                    console.log(res.toJSON());

                    process.exit();
                }
            });
        }
    });
}
