let config;
let db;

module.exports = function Config() {
    const MongoClient = require('mongodb').MongoClient;
    const _async = require('async');
    const path = require('path');
    const nconf = require('nconf');
    const configurationTypes = {
        $or: new Array()
    };

    nconf.file(path.join(__dirname, 'config.json'));

    const vm = this;

    nconf.get('COLLECTIONS').forEach((item)=> {
        configurationTypes.$or.push({
            CONFIG_TYPE: item
        });
    });

    vm.init = function init(done) {
        _async.waterfall([
            function(callback) {
                if (db) {
                    callback(null);
                } else {
                    MongoClient.connect(nconf.get('DATABASE_URL'), (err, _db) => {
                        if (err)
                            callback(err);

                        else {
                            console.log('Database Connected.');

                            db = _db;

                            callback();
                        }
                    });
                }
            },
            function(callback) {
                if (config) {
                    callback();
                } else {

                    db.collection(nconf.get('CONFIG_COLLECTION')).find(configurationTypes).toArray((err, item) => {
                        if (err)
                            callback(err);

                        else if (!item || item.length == 0)
                            callback('No configuration was found.');

                        else {
                            config = combineConfiguration(item);

                            console.log('Configuration Loaded');

                            callback();
                        }
                    });
                }
            }
        ], (err) => {
            if (err) {
                console.error('Error getting Configuration');
                console.error(err);
            } else {
                done();
            }
        });
    };

    vm.getConfig = function() {
        return config;
    };

    vm.get = function (key) {
        if(config[key])
            return JSON.parse(JSON.stringify(config[key]));

        else
            console.error(key, 'Not found in config');
    }

    vm.getDB = function() {
        return db;
    };

    function combineConfiguration(fullConfiguration) {
        var tempConfig = {};

        fullConfiguration.forEach((item) => {
            for(var key in item) {
                if(key == 'CONFIG_TYPE' || key == '_id')
                    continue;

                else if(tempConfig[key]) {
                    console.log('Duplicate', key);
                    console.error('This field already exist in configuration');
                }

                else
                    tempConfig[key] = item[key];
            }
        });

        return tempConfig;
    }

    function updateConfig() {
        db.collection(nconf.get('CONFIG_COLLECTION')).find(configurationTypes).toArray((err, item) => {
            if (err)
                console.error(err);

            else if (!item || item.length == 0)
                console.error('No configuration was found.');

            else
                config = combineConfiguration(item);
        });
    }

    return vm;
};
