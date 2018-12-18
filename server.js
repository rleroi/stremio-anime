var addonSDK = require("stremio-addon-sdk");
var axios = require("axios");
var aesjs = require('aes-js'); // https://www.npmjs.com/package/aes-js
var striptags = require('striptags') // https://www.npmjs.com/package/striptags

/* 
TODO:
- newly added episodes sometimes are shown as upcoming.
    Fix: fix timezone?
- Cache might take too much memory after a while if serving public
    Fix: try to find a metadata api action in the app, or cache in a db.
- sometimes stream url is null. loop over the other sources doesnt help.
    Fix: ???
*/

var manifest = {
    "id": "pw.ers.anime",
    "version": "0.0.1",

    "name": "Anime Addon",
    "description": "Anime series and movies from kissanime",

    // set what type of resources we will return
    "resources": [
        "catalog",
        "meta",
        "stream"
    ],

    "types": ["movie", "series"], // your add-on will be preferred for those content types

    // set catalogs, we'll be making 2 catalogs in this case, 1 for movies and 1 for series
    "catalogs": [
        // {
        //     type: 'movie',
        //     id: 'animemovies',
        //     name: 'KissAnime',
        //     extraSupported: ['search', 'genre']
        // },
        {
            type: 'series',
            id: 'new_and_hot',
            name: 'Anime: New and hot',
            extraSupported: ['search', 'genre']
        },
        {
            type: 'series',
            id: 'most_popular',
            name: 'Anime: Most popular',
            //extraSupported: ['search', 'genre']
        },
        {
            type: 'series',
            id: 'recent_addition',
            name: 'Anime: Recently added',
            //extraSupported: ['search', 'genre']
        },
        // {
        //     type: 'series',
        //     id: 'new_and_hot',
        //     name: 'KissAnime',
        //     extraRequired: ['search']
        // },
    ],

    // prefix of item IDs (ie: "tt0032138")
    "idPrefixes": [ "ka" ]

};

process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0; // accept self-signed certs
var apiOptions = {
    headers: {'Referer': 'https://kisscartoon.io', 'User-Agent': 'AndroidApp - APP2 - - 1.0.15 - com.security.applock.samsung', 'Content-Type': 'application/x-www-form-urlencoded'},
};
var apiUrl = 'https://app.kissanime.co/kiss.php';

var aesKey = aesjs.utils.hex.toBytes('403638383639393937386d6f6e737465');
var aesIv  = aesjs.utils.hex.toBytes('6d6f6e73746539393936353436383638');

var cache = {};

// strip invalid json characters
function stripJson(data) {
    return data.replace(/\\n/g, "\\n")  
               .replace(/\\'/g, "\\'")
               .replace(/\\"/g, '\\"')
               .replace(/\\&/g, "\\&")
               .replace(/\\r/g, "\\r")
               .replace(/\\t/g, "\\t")
               .replace(/\\b/g, "\\b")
               .replace(/\\f/g, "\\f")
               .replace(/[\u0000-\u0019]+/g,"");
}

var addon = new addonSDK(manifest);

// Streaming
addon.defineStreamHandler(function(args, cb) {
    console.log('StreamHandler');
    console.log(args);

    var apiParams = 'action=load_link&episode_id='+args.id.split(':')[3];

    // get animes
    axios.put(apiUrl, apiParams, apiOptions)
    .then((r) => {
        console.log('decrypting response...');
        let aesData = aesjs.utils.hex.toBytes(r.data);
        var aesCbc = new aesjs.ModeOfOperation.cbc(aesKey, aesIv);

        try {
            var result = aesjs.utils.utf8.fromBytes(aesCbc.decrypt(aesData));

            result = stripJson(result);
            var resultObj = JSON.parse(result);

            return axios.put(resultObj.data.player.value, '', apiOptions);

        } catch(e) {
            console.log(e.message);
        }

    })
    .then((data) => {
            var streams = [];

            for(let playlist of data.data.playlist) {
                //console.log(playlist);
                for(let source of playlist.sources) {
                    //console.log(source);
                    streams.push({
                        name: 'KissAnime',
                        title: source.type,
                        url: source.file,
                        tag: [source.label],
                        //isFree: 1
                    });
                }
            }


            return streams;
    })
    .then((streams) => {
        console.log('finish getting streams');
        cb(null, { streams: streams });
    })
    .catch((e) => {
        console.log(e.message);
    })

})

// Metadata
addon.defineMetaHandler((args, cb) => {
    console.log('MetaHandler');
    console.log(args)

    var apiParams = 'action=load_episodes&movie_id='+args.id.split(':')[1];

    // get episodes
    axios.put(apiUrl, apiParams, apiOptions)
    .then((r) => {
        console.log('decrypting response...');
        let aesData = aesjs.utils.hex.toBytes(r.data);
        var aesCbc = new aesjs.ModeOfOperation.cbc(aesKey, aesIv);

        try {
            var result = aesjs.utils.utf8.fromBytes(aesCbc.decrypt(aesData));

            result = stripJson(result);
            var resultObj = JSON.parse(result);
            var videos = [];

            if(typeof resultObj.data.group_episodes != 'undefined') {
                console.log('Episode groups detected');
                console.log(resultObj.data.group_episodes);
                var promises = [];
                for(let group of resultObj.data.group_episodes) {
                    promises.push(axios.put(apiUrl, apiParams+'&group='+group.group, apiOptions));
                }
                return promises;
            } else {
                console.log('Episodes found');
                for(let ep of resultObj.data.episodes) {
                    // if(typeof ep.name.split('Episode ')[1] != 'undefined'){
                    //     var episode = ep.name.split('Episode ')[1];
                    // } else {
                    //     var episode = ep.name;
                    // }

                    // console.log('ep: '+episode);
                    let video = {
                        id: args.id+':1:'+ep.id,
                        title: ep.name,
                        released: new Date(ep.time_create*1000),
                        overview: cache[args.id].overview,
                        streams: [
                            {
                                name: 'KissAnime',
                                title: ep.name,
                                url: 'https://',
                                tag: [ep.quality+'p'],
                                isFree: 1
                            }
                        ],
                        episode: ep.id,//episode,
                        season: 1,
                    };
                    videos.push(video);
                }
            }

            var dataset = {
                id: args.id,
                name: cache[args.id].name,
                overview: cache[args.id].overview,
                description: cache[args.id].overview,
                genres: cache[args.id].genres,
                type: 'series',
                poster: cache[args.id].poster,
                background: cache[args.id].background,
                videos: videos,
                isPeered: true
            };

            return dataset;

        } catch(e) {
            console.log(e.message);
        }

    })
    .then((dataset) => {
        if(Array.isArray(dataset)) {
            Promise.all(dataset).then((rArray) => {
                console.log('Decrypting group data...');
                var videos = [];

                for(let r of rArray) {
                    let aesData = aesjs.utils.hex.toBytes(r.data);
                    var aesCbc = new aesjs.ModeOfOperation.cbc(aesKey, aesIv);
                    var result = aesjs.utils.utf8.fromBytes(aesCbc.decrypt(aesData));
                    result = stripJson(result);
                    var resultObj = JSON.parse(result);
                    //console.log(resultObj);
                    for(let ep of resultObj.data.episodes) {
                        // if(typeof ep.name.split('Episode ')[1] != 'undefined'){
                        //     var episode = ep.name.split('Episode ')[1];
                        // } else {
                        //     var episode = ep.name;
                        // }

                        //console.log('group ep: '+episode);
                        let video = {
                            id: args.id+':'+resultObj.params.group+':'+ep.id,
                            title: ep.name,
                            released: new Date(ep.time_create*1000),
                            overview: cache[args.id].overview,
                            streams: [
                                {
                                    name: 'KissAnime',
                                    title: ep.name,
                                    url: 'https://',
                                    tag: [ep.quality+'p'],
                                    isFree: 1
                                }
                            ],
                            episode: ep.id,//episode,
                            season: resultObj.params.group,
                        };
                        videos.push(video);
                    }
                }


                return videos;
            })
            .then((videos) => {
                var dataset = {
                    id: args.id,
                    name: cache[args.id].name,
                    overview: cache[args.id].overview,
                    description: cache[args.id].overview,
                    genres: cache[args.id].genres,
                    type: 'series',
                    poster: cache[args.id].poster,
                    background: cache[args.id].background,
                    videos: videos,
                    isPeered: true
                };

                console.log('finish getting episodes from group');
                cb(null, { meta: dataset });
                console.log(dataset);
            })
            .catch((e) => {
                console.log(e.message);
            })
        } else {
            console.log('finish getting metadata');
            cb(null, { meta: dataset });
            //console.log(dataset);
        }

    })
    .catch((e) => {
        console.log(e.message);
    })
})

// Catalog
addon.defineCatalogHandler(function(args, cb) {
    console.log('CatalogHandler');
    console.log(args);

    var skip = args.extra.skip ? args.extra.skip : 0;
    var page = skip / 30 + 1;

    var apiParams = 'action=list&sort='+args.id+'&page='+page;

    if(typeof args.extra.genre != 'undefined') {
        apiParams = 'action=genre&genre_slug='+ args.extra.genre.replace(/ /g, "-") +'&page='+page+'&type=slug';
    } else if(typeof args.extra.search != 'undefined') {
        apiParams = 's='+args.extra.search+'&action=search&page='+page;
    }

    // get animes
    axios.put(apiUrl, apiParams, apiOptions)
    .then((r) => {
        console.log('decrypting response...');
        let aesData = aesjs.utils.hex.toBytes(r.data);
        var aesCbc = new aesjs.ModeOfOperation.cbc(aesKey, aesIv);

        try {
            var result = aesjs.utils.utf8.fromBytes(aesCbc.decrypt(aesData));

            result = stripJson(result);
            var resultObj = JSON.parse(result);

            var dataset = [];

            for(let ani of resultObj.data.anime_list) {
                var genres = ani.genre.split(',');
                genres.forEach((g, i) => {
                    genres[i] = g.trim();
                });

                aniData = {
                    id: "ka:"+ani.id,
                    name: ani.name,
                    genres: genres,
                    overview: striptags(ani.description),
                    poster: ani.thumb,
                    background: ani.cover,
                    type: 'series',
                };
                
                dataset.push(aniData);
                cache = Object.assign({["ka:"+ani.id]: aniData}, cache);
            }

            return dataset;

        } catch(e) {
            console.log(e.message);
        }

    })
    .then((dataset) => {
        console.log('finish getting animes for catalog');
        cb(null, { metas: dataset });
    })
    .catch((e) => {
        console.log(e.message);
    })

})



if (module.parent) {
    module.exports = addon
} else {
    addon.runHTTPWithOptions({ port: 80 })
}