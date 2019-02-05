exports = module.exports = function(io, service) {
    var config = require('../config/config')();
    var mongo = require('mongodb');
    var sockets = new Object();
    var iron = require('iron');
    var cookie = require('cookie');
    var db = config.getDB();

    io.sockets.on('connection', function(socket) {
        if (!socket.request.headers.cookie) {
            console.error('\nNo cookie found in Socket.IO...\n');
            return;
        }
        var cookies = cookie.parse(socket.request.headers.cookie);

        if(!cookies.sid) {
            console.error('Session Id not present in Socket.IO cookie...');
            return;
        }

        iron.unseal(cookies.sid, config.get('SESSION_PASSWORD'), iron.defaults, function(err, data) {
            if(err)
                console.error(err);

            else if(sockets[data.user._id.toString()]) {
                if(sockets[data.user._id.toString()].authToken != data.user.AUTH_TOKEN) {
                    console.log('Multiple session detected.');
                    console.log('in session', sockets[data.user._id.toString()].authToken);
                    console.log('in db', data.user.AUTH_TOKEN);

                    sockets[data.user._id.toString()].socket.emit('multipleSession');

                    sockets[data.user._id.toString()] = {
                        socket : socket,
                        authToken : data.user.AUTH_TOKEN
                    }
                }

                else {
                    console.log('Old Session for', data.user.EMAIL_ID);

                    sockets[data.user._id.toString()] = {
                        socket : socket,
                        authToken : data.user.AUTH_TOKEN
                    }
                }
            }

            else {
                console.log('New Session for', data.user.EMAIL_ID);

                sockets[data.user._id.toString()] = {
                    socket : socket,
                    authToken : data.user.AUTH_TOKEN
                }
            }
        });

        socket.on('saveClassificationProgress', function(data) {
            console.log('Socket.IO saveClassificationProgress', (new Date()).toString());
            console.log(data);

            db.collection(config.get('WORKING_IMAGES_COLLECTION')).update({
                USER_OID: new mongo.ObjectID(data.USER_OID),
                OWNER_OID: new mongo.ObjectID(data.USER_OID),
                PROJECT_ID : data.PROJECT_ID,
                OBJECT_OID: new mongo.ObjectID(data.OBJECT_OID)
            }, {
                $set: {
                    LABEL_DETAILS: data.data,
                    SECONDS : data.seconds,
                    MINUTES : data.minutes,
                    HOURS : data.hours
                },
                $setOnInsert: {
                    PROJECT_ID : data.PROJECT_ID,
                    USER_OID: new mongo.ObjectID(data.USER_OID),
                    OBJECT_OID: new mongo.ObjectID(data.OBJECT_OID)
                }
            }, {
                upsert: true
            }, function(err) {
                if (err)
                    console.error(err);
            });
        });

        socket.on('disconnect', function () {
            console.log('disconnect');
        });

        socket.on('logout', function () {
            console.log('logout removing data from sockets');

            iron.unseal(cookies.sid, config.get('SESSION_PASSWORD'), iron.defaults, function(err, data) {
                if(err)
                    console.error(err);

                else if(sockets[data.user._id.toString()])
                    delete sockets[data.user._id.toString()];
            });
        });
    });

    module.exports.sockets = sockets;
}
