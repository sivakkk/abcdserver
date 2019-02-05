module.exports = function(service) {
    var config = require('../config/config')();
    var _async = require('async');
    var mongo = require('mongodb');
    var db = config.getDB();

    return this;
}
