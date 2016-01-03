var SpotifyWebApi = require('spotify-web-api-node');
var express = require('express');
var router = express.Router(); 
var MongoClient = require('mongodb').MongoClient;
var config = require('../config');
var mongoUrl = config.mongo_url;
var ObjectID = require('mongodb').ObjectID;
var assert = require('assert');

var scopes = ['playlist-read-private', 'user-read-email'],
    redirectUri = config.spotify_redirect,
    clientId = 'a9b262c869aa4a9391f78deb6bc5af3d',
    clientSecret = '449989ef56f041ce98079391c1952bd2',
    state = 'login';

	var spotifyApi = new SpotifyWebApi({
	  redirectUri : redirectUri,
	  clientId : clientId, 
	  clientSecret: clientSecret, 
	  authorize_params: {
        show_dialog: 'true'
      }
	});

function userExists (token, callback) {
	spotifyApi.setAccessToken(token); 
	spotifyApi.getMe()
	  .then(function(data) {
	    MongoClient.connect(mongoUrl, function (err, db) {
	    	db.collection('users').findOne({spotify_id: data.body.id}, function (err, result) {
	    		db.close();
	    		var toReturn = (!result) ? false : result.spotify_id;
	    		callback(toReturn);
	    	}); 
	    });
	  }, function(err) {
	  		callback(false);
	  });
}

function getIntersection (array1, array2) {
	var inCommon = [];	
	var startJ = 0; 
	for (var i = 0; i < array1.length; i++) {
		for (var j = startJ; j < array2.length; j++) {
			if (array1[i] == array2[j]) {
				inCommon.push(array1[i]);
				startJ = j;
				break;
			}
			if (array1[i] < array2[j]) {
				startJ = j; 
				break;
			}
		}
	}
	
	return inCommon;
}

router.get('/logout', function (req, res) { 
	req.session.userId = false; 
	res.redirect('/');
}); 

router.get('/', function (req, res) {
	var loggedIn = (!req.session.userId) ? false: true;  
	res.render('home', {loggedIn: loggedIn});
}); 

router.get('/login', function (req, res) {
	var authorizeURL = spotifyApi.createAuthorizeURL(scopes, state);
	res.redirect(authorizeURL + "&show_dialog=true");
});

router.get('/auth/spotify/callback', function (req, res){
	var code = req.query.code; 
	spotifyApi.authorizationCodeGrant(code)
		.then(function(data) {
			req.session.token = data.body['access_token'];
			spotifyApi.setAccessToken(data.body['access_token']);
    		spotifyApi.setRefreshToken(data.body['refresh_token']);
			
			userExists(data.body['access_token'], function (id) {
				if (!id) {
					res.redirect(302, '/add-user'); 
				} else {
					req.session.userId = id; 
					res.redirect(302, '/');
				}
			}); 

		}, function (err) {
			res.send('Error Loggin In');
		});
});

router.get('/add-user', function (req, res) {
	if(!req.session.token) {
		res.redirect('/login');
	} else {
		res.render('login', {token: req.session.token}); 
	}
}); 

router.post('/add-user', function (req, res) {
	if(!req.session.token) {
		res.redirect('/login');
	} else {
		MongoClient.connect(mongoUrl, function (err, db) {
			if (err) { 
				res.status(500).send('Database Error');
			}
			db.collection('users').insertOne(req.body, function (err, result) {
				db.close();
				if (err) {
					res.status(500).send('Database Error');
				} else {
					req.session.userId = result.ops[0].spotify_id; 
					res.status(201).send(result.ops[0].spotify_id);
				}
			}); 
		}); 
	}
});

router.get('/compare/:spotify_id', function (req, res) {
	if (!req.session.userId) {
		res.redirect('/'); 
	} else {
		MongoClient.connect(mongoUrl, function (err, db) { 
			try {
				db.collection('users').findOne({spotify_id: req.params.spotify_id}, function (err, user){
					if (err) {console.log(err);}
					if (!user) {
						db.close();
						res.send('User Not Found');
					}
					db.collection('users').findOne({spotify_id:req.session.userId}, function (err, user2){
						db.close();
						var artistsInCommon = getIntersection(user.sorted_artists, user2.sorted_artists);
						var tracksInCommon = getIntersection(user.sorted_tracks, user2.sorted_tracks);
						var artists = {};
						var tracks = {};
						for (var i = 0; i < artistsInCommon.length; i++){
							artists[artistsInCommon[i]] = user2.artists[artistsInCommon[i]];
						}
						for (var i = 0; i < tracksInCommon.length; i++){
							tracks[tracksInCommon[i]] = user2.tracks[tracksInCommon[i]];
						}
						var percent = ((tracksInCommon.length + artistsInCommon.length)/50*100).toFixed(2); 
						res.render('compare', {
							percent: percent,  
							tracks: tracks, 
							artists: artists, 
							currentDwId: user2.dw_spotify_id,
							otherDwId: user.dw_spotify_id,
							currentDisplayName: user2.display_name,
							otherDisplayName: user.display_name,
							currentProfilePic: user2.profile_pic,
							otherProfilePic: user.profile_pic 
						});

					});
				});
			} catch (e){
				db.close();
				res.send('User Not Found');
			}
		});
	}

}); 

router.get('/discover', function (req, res) {
	if (!req.session.userId) {
		res.redirect('/');
	} else {
		MongoClient.connect(mongoUrl, function (err, db) {
			assert.equal(null, err);
			compareUsers(req.session.userId, db, function (spotify_id) {
				db.close();
				res.redirect(302, '/compare/'+spotify_id);
			});
		});
	}
}); 

router.get('/random', function (req, res) { 
	if (!req.session.userId) { 
		res.redirect('/');
	} else {
		MongoClient.connect(mongoUrl, function (err, db) {
			assert.equal(null, err);
			db.collection('users').aggregate(
				[
					{ $match: {spotify_id: {$ne: req.session.userId}}},
					{ $sample: { size: 1 }}
				], function (err, randomUser){
					db.close();
					res.redirect(302, '/compare/'+randomUser[0].spotify_id);
			});
		}); 
	}
}); 

function searchUsers (search, page, callback) { 
	page = parseInt(page);
	if (!page || isNaN(page)) {
		page = 0; 
	}
	MongoClient.connect(mongoUrl, function (err, db) {
		db.collection('users').find(
			{display_name: {$regex:search,  $options: 'i'}},
			{spotify_id:1, display_name:1, profile_pic: 1},
			{limit: 10, offset:page}).toArray(function (err, users){

			db.close(); 
			callback(users);

		});
	});
}

function getSearch (req, res) {
	if (!req.session.userId) { 
		res.redirect('/');
	} else if (req.query.q) { 
		searchUsers(req.query.q, req.query.page, function (users){
			res.render('search', {users: req.users});
		});
	} else {
		res.render('search', {users: req.users});
	}
}
router.get('/search', getSearch); 

router.post('/search', function (req, res) {
	if (!req.session.userId) { 
		res.redirect('/');
	} else {
		searchUsers(req.body.search, req.query.page, function (users){
			req.users = users; 
			getSearch(req, res);
		});
	}
}); 

router.get('/not_found', function (req, res) {
	if (!req.session.userId){
		res.redirect('/');
	} else {
		res.status(404).render('not_found');
	}
}); 

router.get('/about', function (req, res) {
	res.render('about');
});

var compareUsers = function(currentId, db, callback) {
	var artistsMax = 0;
	var tracksMax = 0; 
	var match = false; 
	var collection = db.collection('users');
	collection.findOne({spotify_id: currentId}, function(err, currentUser) {
		var cursor = collection.find({spotify_id: {"$ne": currentUser.spotify_id}});
		cursor.each(function(err, user2) {
		  if (user2 != null && currentUser.spotify_id != user2.spotify_id) {
		    var tracksInCommon = getIntersection(currentUser.sorted_tracks, user2.sorted_tracks);
		    if (tracksInCommon.length >= tracksMax) {
		    	var artistsInCommon = getIntersection(currentUser.sorted_artists, user2.sorted_artists); 
		    	if (tracksInCommon.length > tracksMax || (tracksInCommon.length == tracksMax && artistsInCommon.length > artistsMax)){
			    	tracksMax = tracksInCommon.length; 
			    	artistsMax = artistsInCommon.length;
			    	match = user2.spotify_id;
			    }
		    } 
		  } else {
		  	callback(match); 
		  } 
		});
	});

};

module.exports = router;
