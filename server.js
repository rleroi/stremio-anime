var addonSDK = require("stremio-addon-sdk");
var axios = require("axios");
var aesjs = require('aes-js'); // https://www.npmjs.com/package/aes-js
var striptags = require('striptags') // https://www.npmjs.com/package/striptags

/* 
TODO:
- Try to connect anime with imdb ID to show steam in Cinemeta addon
    Fix: see https://github.com/Stremio/stremio-addons/blob/master/docs/tutorial/using-cinemeta.md, but i think it only searches on filename. We could try searching anime name (without (dub) etc.) on a movie database api
- Cache might take too much memory after a while
    Fix: try to find a metadata api action in the app, or cache in a db.
- sometimes stream url from kissanime server is empty. loop over the other sources doesnt seem to help?
    Fix: request twice, they always seem to work on the second try
- check logs: 'no stream url found' and see if there are some with more than '1 1' for stream sources. if so, we shouldn't return on first invalid url. instead, loop over all and do the promise stuff in an array and use Promise.all().then(). so we can push all streams to the streams array
- check logs: 'Cannot read property'
    Fix: ???
*/

var manifest = {
    "id": "pw.ers.anime",
    "version": "0.0.3",

    "name": "Anime Add-on",
    "description": "Go to Discover -> Series -> Anime to watch! If you like this add-on, you can donate to help pay for server costs: https://buymeacoff.ee/anime",

	"icon": "https://img00.deviantart.net/7b0b/i/2011/273/9/c/anime_totoro_dock_icon_by_cmnixon-d4belub.png",
	
    // set what type of resources we will return
    "resources": [
        "catalog",
        "meta",
        "stream"
    ],

    "types": ["series"], // your add-on will be preferred for those content types

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
            name: 'Anime: Hot',
            extraSupported: ['search', 'genre']
        },
        {
            type: 'series',
            id: 'most_popular',
            name: 'Anime: Popular',
            //extraSupported: ['search', 'genre']
        },
        {
            type: 'series',
            id: 'recent_addition',
            name: 'Anime: New',
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

var cache = {}; // saves series metadata
var requestCache = {}; // saves kissanime api requests. key = the request params. Thanks BoredLama

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
addon.defineStreamHandler((args, cb) => {
    console.log('StreamHandler', args);

    var apiParams = 'action=load_link&episode_id='+args.id.split(':')[3];

    // try to get from cache
    if(requestCache[apiParams]) {
        //console.log(requestCache[apiParams]);
        return cb(null, { streams: requestCache[apiParams] });
    }

    // get animes
    axios.put(apiUrl, apiParams, apiOptions)
    .then((r) => {
        //console.log('decrypting response...');
        let aesData = aesjs.utils.hex.toBytes(r.data);
        var aesCbc = new aesjs.ModeOfOperation.cbc(aesKey, aesIv);

        try {
            var result = aesjs.utils.utf8.fromBytes(aesCbc.decrypt(aesData));

            result = stripJson(result);
            var resultObj = JSON.parse(result);

            return axios.put(resultObj.data.player.value, '', apiOptions);

        } catch(e) {
            console.log(e.message);
            cb(new Error('Error getting streams'), null);
        }

    })
    .then((data) => {
        var streams = [];

        for(let playlist of data.data.playlist) {
            //console.log(playlist);
            for(let source of playlist.sources) {

                if(!source.file) {
                    console.log('no stream url found', data.data.playlist.length, playlist.sources.length);
                    return cb(null, { streams: streams });
                    //continue;
                }

                if(!source.file.endsWith('.m3u8') && !source.file.endsWith('.m3u')) {
                    // don't apply BoredLama's fix on non-m3u8 streams
                    streams.push({
                        name: 'KissAnime',
                        title: source.type,
                        url: source.file,
                        tag: [source.label],
                        //isFree: 1
                    });

                    console.log('save streams to cache');
                    requestCache[apiParams] = streams;
                    // delete from cache after 1 minute
                    setTimeout(() => { delete requestCache[apiParams] }, 60*1000);

                    return cb(null, { streams: streams });
                }

                //console.log('requesting', source.file);

                // BoredLama's m3u8 fix | https://github.com/rleroi/stremio-anime/issues/3
                axios.get(source.file)
                .then((r) => {
                    const body = r.data;
                    if (!body || !body.includes('#EXTM3U')) {
                        console.error(new Error('Error 1: The HLS Playlist Failed Parsing'))
                    } else {
                        if (!body.includes('#EXTINF')) {
                            if ((body.includes('http:') || body.includes('https:')) && body.includes('.m3u')) {
                                const lines = body.split(/\n/)
                                let m3uList
                                lines.some(line => {
                                    if (line.startsWith('http')) {
                                        m3uList = line
                                        return true
                                    }
                                })
                                if (!m3uList) {
                                    console.error(new Error('Error 2: The HLS Playlist Failed Parsing'))
                                } else {
                                    // Success: Correct HLS Playlist is: "m3uList"; Send to Stremio
                                    //console.log('successfully applied BoredLama\'s fix');
                                    streams.push({
                                        name: 'KissAnime',
                                        title: source.type,
                                        url: m3uList,
                                        tag: [source.label],
                                        //isFree: 1
                                    });
                                }
                            } else {
                                console.error(new Error('Error 3: The HLS Playlist Does Not Include Any .ts Files or .m3u / .m3u8 Files'))
                            }
                        } else {
                            // Success: Correct HLS Playlist is: "hlsUrl"; Send to Stremio
                            streams.push({
                                name: 'KissAnime',
                                title: source.type,
                                url: hlsUrl,
                                tag: [source.label],
                                //isFree: 1
                            });
                        }
                    }
                    return streams;
                })
                .then((streams) => {
                    console.log('save streams to cache');
                    requestCache[apiParams] = streams;
                    // delete from cache after 1 minute
                    setTimeout(() => { delete requestCache[apiParams] }, 60*1000);

                    return cb(null, { streams: streams });
                })
                .catch((e) => {
                    console.error(e)
                    cb(new Error('Error getting streams'), null);
                })
            }
        }
    })
    .catch((e) => {
        console.log(e);
        cb(new Error('Error getting streams'), null);
    })

})

// Metadata
addon.defineMetaHandler((args, cb) => {
    console.log('MetaHandler', args)

    var apiParams = 'action=load_episodes&movie_id='+args.id.split(':')[1];

    // try to get from cache
    if(requestCache[apiParams]) {
        return cb(null, { meta: requestCache[apiParams] });
    }

    // get episodes
    axios.put(apiUrl, apiParams, apiOptions)
    .then((r) => {
        //console.log('decrypting response...');
        let aesData = aesjs.utils.hex.toBytes(r.data);
        var aesCbc = new aesjs.ModeOfOperation.cbc(aesKey, aesIv);

        try {
            var result = aesjs.utils.utf8.fromBytes(aesCbc.decrypt(aesData));

            result = stripJson(result);
            var resultObj = JSON.parse(result);
            var videos = [];

            if(typeof resultObj.data.group_episodes != 'undefined') {
                //console.log('Episode groups detected');
                //console.log(resultObj.data.group_episodes);
                var promises = [];
                for(let group of resultObj.data.group_episodes) {
                    promises.push(axios.put(apiUrl, apiParams+'&group='+group.group, apiOptions));
                }
                return promises;
            } else {
                //console.log('Episodes found');
                for(let ep of resultObj.data.episodes) {
                    
                    var episode = ep.name.match(/[0-9]+/g);
                    
                    if(!episode) {
                        episode = ep.id
                    } else {
                        episode = episode[[0]]
                    }
                    episode = parseInt(episode);

                    //console.log('ep: '+episode);
                    let video = {
                        id: args.id+':1:'+ep.id,
                        title: ep.name,
                        released: new Date(0+episode), // fix order
                        //overview: cache[args.id].overview,
                        //description: cache[args.id].overview,
                        streams: [
                            {
                                name: 'KissAnime',
                                title: ep.name,
                                url: 'https://',
                                tag: [ep.quality+'p'],
                                isFree: 1
                            }
                        ],
                        episode: episode, //ep.id
                        season: 1,
                    };
                    videos.push(video);
                }
            }

            // let's sort the episodes. // doesn't matter, for some reason stremio doesn't show the correct order
            // videos.sort((a,b) => {
            //     if(a.title < b.title) {
            //         return -1;
            //     } else if(a.title > b.title) {
            //         return 1
            //     }
            //     return 0;
            // })

            var dataset = {
                id: args.id,
                name: cache[args.id].name,
                //overview: cache[args.id].overview,
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
            console.log(e);
            cb(new Error('Error getting episodes'), null);
        }

    })
    .then((dataset) => {
        if(Array.isArray(dataset)) {
            Promise.all(dataset).then((rArray) => {
                //console.log('Decrypting group data...');
                var videos = [];

                season = rArray.length;

                // foreach group in groups
                for(let r of rArray) {
                    let aesData = aesjs.utils.hex.toBytes(r.data);
                    var aesCbc = new aesjs.ModeOfOperation.cbc(aesKey, aesIv);
                    var result = aesjs.utils.utf8.fromBytes(aesCbc.decrypt(aesData));
                    result = stripJson(result);
                    var resultObj = JSON.parse(result);
                    //console.log(resultObj);

                    // foreach episode in group
                    for(let ep of resultObj.data.episodes) {
                    var episode = ep.name.match(/[0-9]+/g);
                    
                        if(!episode) {
                            episode = ep.id
                        } else {
                            episode = episode[[0]]
                        }
                        episode = parseInt(episode);

                        //console.log('group ep: '+episode);
                        let video = {
                            id: args.id+':'+resultObj.params.group+':'+ep.id,
                            title: ep.name,
                            released: new Date(0+episode),
                            //overview: cache[args.id].overview,
                            //description: cache[args.id].overview,
                            streams: [
                                {
                                    name: 'KissAnime',
                                    title: ep.name,
                                    url: 'https://',
                                    tag: [ep.quality+'p'],
                                    isFree: 1
                                }
                            ],
                            episode: episode, // ep.id,
                            season: season //resultObj.params.group,
                        };
                        videos.push(video);
                    }
                    season--;
                }                

                // let's sort the episodes
                // videos.sort((a,b) => {
                //     if(a.title < b.title) {
                //         return -1;
                //     } else if(a.title > b.title) {
                //         return 1
                //     }
                //     return 0;
                // })

                return videos;
            })
            .then((videos) => {
                var dataset = {
                    id: args.id,
                    name: cache[args.id].name,
                    //overview: cache[args.id].overview,
                    description: cache[args.id].overview,
                    genres: cache[args.id].genres,
                    type: 'series',
                    poster: cache[args.id].poster,
                    background: cache[args.id].background,
                    videos: videos,
                    isPeered: true
                };


                console.log('save meta to cache');
                requestCache[apiParams] = dataset;
                // delete from cache after 1 day
                setTimeout(() => { delete requestCache[apiParams] }, 86400000); // 60*60*24*1000

                cb(null, { meta: dataset });
            })
            .catch((e) => {
                console.log(e);
                cb(new Error('Error getting episodes'), null);
            })
        } else {
            console.log('save meta to cache');
            requestCache[apiParams] = dataset;
            // delete from cache after 1 day
            setTimeout(() => { delete requestCache[apiParams] }, 86400000); // 60*60*24*1000

            cb(null, { meta: dataset });
        }

    })
    .catch((e) => {
        console.log(e);
        cb(new Error('Error getting episodes'), null);
    })
})

// Catalog
addon.defineCatalogHandler((args, cb) => {
    console.log('CatalogHandler', args);

    var skip = args.extra.skip ? args.extra.skip : 0;
    var page = skip / 30 + 1;

    var apiParams = 'action=list&sort='+args.id+'&page='+page;

    if(typeof args.extra.genre != 'undefined') {
        apiParams = 'action=genre&genre_slug='+ args.extra.genre.replace(/ /g, "-") +'&page='+page+'&type=slug';
    } else if(typeof args.extra.search != 'undefined') {
        apiParams = 's='+args.extra.search+'&action=search&page='+page;
    }

    // try to get from cache
    if(requestCache[apiParams]) {
        return cb(null, { metas: requestCache[apiParams] });
    }

    // get animes
    axios.put(apiUrl, apiParams, apiOptions)
    .then((r) => {
        //console.log('decrypting response...');
        let aesData = aesjs.utils.hex.toBytes(r.data);
        var aesCbc = new aesjs.ModeOfOperation.cbc(aesKey, aesIv);
        //console.log(r.data);

        try {
            var result = aesjs.utils.utf8.fromBytes(aesCbc.decrypt(aesData));

            result = stripJson(result);
            var resultObj = JSON.parse(result);
            //console.log(resultObj);

            var dataset = [];

            if(typeof resultObj.data == "undefined") {
                throw new Error('Error getting '+args.extra.genre);
            }

            for(let ani of resultObj.data.anime_list) {
                var genres = ani.genre.split(',');
                genres.forEach((g, i) => {
                    genres[i] = g.trim();
                });

                aniData = {
                    id: "ka:"+ani.id,
                    name: ani.name,
                    genres: genres,
                    //overview: striptags(ani.description),
                    description: striptags(ani.description),
                    poster: ani.thumb,
                    background: ani.cover,
                    type: 'series',
                };
                
                dataset.push(aniData);
                cache = Object.assign({["ka:"+ani.id]: aniData}, cache);
            }

            return dataset;

        } catch(e) {
            console.log(e);
            cb(new Error('Error getting catalog'), null);
        }

    })
    .then((dataset) => {
        console.log('save catalog to cache');
        requestCache[apiParams] = dataset;
        // delete from cache after 1 day
        setTimeout(() => { delete requestCache[apiParams] }, 86400000); // 60*60*24*1000

        cb(null, { metas: dataset });
    })
    .catch((e) => {
        console.log(e);
        cb(new Error('Error getting catalog'), null);
    })

})



if (module.parent) {
    module.exports = addon
} else {
    addon.publishToCentral('https://anime.ers.pw/manifest.json')

    addon.runHTTPWithOptions({ port: 7000 });
}