const { addonBuilder, serveHTTP, publishToCentral } = require("stremio-addon-sdk");
const axios = require("axios");
const aesjs = require('aes-js'); // https://www.npmjs.com/package/aes-js
const striptags = require('striptags'); // https://www.npmjs.com/package/striptags

/* 
TODO:
- Try to connect anime with imdb ID to show stream in Cinemeta addon
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
    "version": "0.0.4",

    "name": "Anime Add-on",
    "description": "New version!",

	"icon": "https://img00.deviantart.net/7b0b/i/2011/273/9/c/anime_totoro_dock_icon_by_cmnixon-d4belub.png",
	
    // set what type of resources we will return
    "resources": [
        "catalog",
        "meta",
        "stream"
    ],

    "types": ["series", "movie"], // your add-on will be preferred for those content types

    // set catalogs, we'll be making 2 catalogs in this case, 1 for movies and 1 for series
    "catalogs": [
        {
            type: 'series',
            id: 'kissanime',
            name: 'Anime',
            extraSupported: ['search', 'genre'],
            genres: [
                'New and Hot',
                'Recently Added',
                //'Most Popular',
                'Action',
                'Adventure',
                'Cars',
                'Cartoon',
                'Comedy',
                'Dementia',
                'Demons',
                'Drama',
                'Dub',
                //'Ecchi', // not working
                'Fantasy',
                'Game',
                'Harem',
                'Historical',
                'Horror',
                'Josei',
                'Kids',
                'Magic',
                'Martial Arts',
                'Mecha',
                'Military',
                'Movie',
                'Music',
                'Mystery',
                'ONA',
                'OVA',
                'Parody',
                'Police',
                'Psychological',
                'Romance',
                'Samurai',
                'School',
                'Sci-Fi',
                'Seinen',
                'Shoujo',
                'Shoujo Ai',
                'Shounen',
                'Shounen Ai',
                'Slice of Life',
                'Space',
                'Special',
                'Sports',
                'Super Power',
                'Supernatural',
                'Thriller',
                'Vampire',
                'Yuri',
            ]
        },
        {
            type: 'movie',
            id: 'kissanime',
            name: 'Anime',
            extraSupported: ['genre'],
            genres: [
                'New and Hot',
                'Recently Added',
                //'Most Popular',
                'Action',
                'Adventure',
                'Cars',
                'Cartoon',
                'Comedy',
                'Dementia',
                'Demons',
                'Drama',
                'Dub',
                //'Ecchi', //not working
                'Fantasy',
                'Game',
                'Harem',
                'Historical',
                'Horror',
                'Josei',
                'Kids',
                'Magic',
                'Martial Arts',
                'Mecha',
                'Military',
                'Movie',
                'Music',
                'Mystery',
                'ONA',
                'OVA',
                'Parody',
                'Police',
                'Psychological',
                'Romance',
                'Samurai',
                'School',
                'Sci-Fi',
                'Seinen',
                'Shoujo',
                'Shoujo Ai',
                'Shounen',
                'Shounen Ai',
                'Slice of Life',
                'Space',
                'Special',
                'Sports',
                'Super Power',
                'Supernatural',
                'Thriller',
                'Vampire',
                'Yuri',
            ]
        },
    ],

    // prefix of item IDs (ie: "tt0032138")
    "idPrefixes": [ "ka" ]

};

const addon = new addonBuilder(manifest);



process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0; // accept self-signed certs

const apiOptions = {
    headers: {'Referer': 'https://kisscartoon.io', 'User-Agent': 'AndroidApp - APP2 - - 1.0.15 - com.security.applock.samsung', 'Content-Type': 'application/x-www-form-urlencoded'},
};
const apiUrl = 'https://app.kissanime.co/kiss.php';

const aesKey = aesjs.utils.hex.toBytes('403638383639393937386d6f6e737465');
const aesIv  = aesjs.utils.hex.toBytes('6d6f6e73746539393936353436383638');

let cache = {}; // saves series metadata
let requestCache = {}; // saves kissanime api requests. key = the request params. Thanks BoredLama

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

// BoredLama's m3u8 fix | https://github.com/rleroi/stremio-anime/issues/3
function m3uFix(url) {
    if(!url.endsWith('.m3u8') && !url.endsWith('.m3u')) {
        return {url: url, type: 'HLS'};
    }

    let result = axios.get(url).then((r) => {
        const body = r.data;
        if (!body || !body.includes('#EXTM3U')) {
            console.error(new Error('Error 1: The HLS Playlist Failed Parsing'))
        } else {
            if (!body.includes('#EXTINF')) {
                if ((body.includes('http:') || body.includes('https:')) && body.includes('.m3u')) {
                    const lines = body.split(/\n/);
                    let m3uList;
                    lines.some(line => {
                        if (line.startsWith('http')) {
                            m3uList = line;
                            return true
                        }
                    });
                    if (!m3uList) {
                        console.error(new Error('Error 2: The HLS Playlist Failed Parsing'))
                    } else {
                        // Success: Correct HLS Playlist is: "m3uList"; Send to Stremio
                        return {url: m3uList, type: 'HLS'};
                    }
                } else {
                    console.error(new Error('Error 3: The HLS Playlist Does Not Include Any .ts Files or .m3u / .m3u8 Files'))
                }
            } else {
                // Success: Correct HLS Playlist is: "url"; Send to Stremio
                return {url: url, type: 'HLS'};
            }
        }
    })
    .catch((e) => {
        console.error('Error applying m3uFix: ', e)
    })

    console.log('m3uFix result: ', result);
    return result;
}




// Streaming
addon.defineStreamHandler(async (args) => {
    console.log('StreamHandler', args);

    let apiParams = 'action=load_link&episode_id='+args.id.split(':')[3];

    // try to get from cache
    if(requestCache[apiParams]) {
        //console.log(requestCache[apiParams]);
        return Promise.resolve({ streams: requestCache[apiParams], cacheMaxAge: 300});
    }


    //const proxy = 'http://goxcors.appspot.com/cors?method=PUT&header=Content-Type%7Capplication%2Fx-www-form-urlencoded&header=User-Agent%7CAndroidApp%20-%20APP2%20-%20-%201.0.15%20-%20com.security.applock.samsung&header=Referer%7Chttps%3A%2F%2Fkisscartoon.io&url=';
    //const proxyVideo = 'http://goxcors.appspot.com/cors?method=GET&url=';

    //const proxy = 'http://localhost:63342/stremio-anime/public/fb-redirect.html?url=';

    // get animes and return returned promise
    return axios.put(apiUrl, apiParams, apiOptions).then((r) => {
        //console.log('decrypting response...');
        let aesData = aesjs.utils.hex.toBytes(r.data);
        let aesCbc = new aesjs.ModeOfOperation.cbc(aesKey, aesIv);

        let result = aesjs.utils.utf8.fromBytes(aesCbc.decrypt(aesData));

        result = stripJson(result);
        let resultObj = JSON.parse(result);

        // does it sometimes return a direct video link already?
        if(resultObj.data.player.value.startsWith('https://play.kissanime.ac')) {
            // return another promise with the actual video streams.
            return axios.put(resultObj.data.player.value, '', apiOptions);
        } else {
            // try to load as external url? log it for now
            console.log('NEW TYPE OF VIDEO: ', resultObj.data.player.value);
            return Promise.reject(new Error('Unsupported video'));
        }

    }).then((r) => {
        let promises = [];

        // todo: maybe there's more sources, like google video.
        // todo: found a (deleted) openload video, but it tried to make a request to it. Was it a direct link, not generated by play.kissanime.ac?

        for (let playlist of r.data.playlist) {
            //console.log(playlist);
            for (let source of playlist.sources) {

                if (!source.file) {
                    console.log('no stream url found in playlist.sources.file.', JSON.stringify(r.data));
                    //return Promise.resolve({ streams: streams });
                    continue;
                }

                console.log('found a playlist stream', source.file);
                promises.push(m3uFix(source.file));
            }
        }

        // fb streams only work when generated with client's IP
        /*if (r.data.fb) {
            console.log(r.request.path);
            console.log('found a fb stream, ', proxy+encodeURIComponent(r.request.path), 'we should return the proxy + api url to generate one on the client');
            promises.push({url: proxy+encodeURIComponent(r.request.path), type: 'FB'});
        }*/

        return promises;

    }).then((promises) => {
        // return streams
        return Promise.all(promises).then(rArray => {
            let streams = [];
            for (let i = 0; i < rArray.length; i++) {
                streams.push(
                    rArray[i].type === 'FB' ?
                    {
                        name: 'Anime Addon',
                        title: 'Stream ' + (i + 1)+', '+rArray[i].type,
                        externalUrl: rArray[i].url,
                        //tag: 'tag',
                        //isFree: 1
                    } : {
                        name: 'Anime Addon',
                        title: 'Stream ' + (i + 1)+', '+rArray[i].type,
                        url: rArray[i].url,
                        //tag: 'tag',
                        //isFree: 1
                    }

                );
            }

            if(streams.length) {
                console.log('save streams to cache');
                requestCache[apiParams] = streams;

                setTimeout(() => {
                    delete requestCache[apiParams]
                }, 60 * 1000); // cache 1 minute

                return {streams: streams, cacheMaxAge: 60};
            } else {
                console.log('no streams found');
                return Promise.reject(new Error('No streams found'));
            }

        }).catch(e => {
            console.log(e.message);
        })


    }).catch((e) => {
        console.log(e.message);
        return Promise.reject(new Error('Error getting streams'));
    })
})

// Metadata
addon.defineMetaHandler((args) => {
    console.log('MetaHandler', args);

    let apiParams = 'action=load_episodes&movie_id='+args.id.split(':')[1];

    // try to get from cache
    if(requestCache[apiParams]) {
        return Promise.resolve({ meta: requestCache[apiParams] });
    }

    // get episodes and return the returned promise
    let result = axios.put(apiUrl, apiParams, apiOptions).then((r) => {
        //console.log('decrypting response...');
        let aesData = aesjs.utils.hex.toBytes(r.data);
        let aesCbc = new aesjs.ModeOfOperation.cbc(aesKey, aesIv);

        let result = aesjs.utils.utf8.fromBytes(aesCbc.decrypt(aesData));

        result = stripJson(result);
        let resultObj = JSON.parse(result);
        let videos = [];
        let promises = [];

        if(typeof resultObj.data.group_episodes != 'undefined') {
            console.log('Episode groups detected');
            //console.log(resultObj.data.group_episodes);
            for(let group of resultObj.data.group_episodes) {
                promises.push(axios.put(apiUrl, apiParams+'&group='+group.group, apiOptions));
            }
        } else {
            console.log('Episodes found');
            for(let ep of resultObj.data.episodes) {

                let episode = ep.name.match(/[0-9]+/g);

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
                    released: new Date(episode), // fix order
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

            let dataset = {};
            // check if cache contains this anime
            console.log('does our cache contain this anime?', typeof cache[args.id]);

            if(!cache[args.id]) {
                console.log('meta cache doesnt contain '+args.id);

                // TODO: rebuild meta cache on (re)start, or here, when not found
                dataset = {
                    id: args.id,
                    name: 'undefined',
                    //overview: cache[args.id].overview,
                    description: 'undefined',
                    genres: 'undefined',
                    type: 'series',
                    poster: '',
                    background: '',
                    videos: videos,
                    isPeered: true
                };
            } else {
                // build dataset from videos list and our meta cache
                dataset = {
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

                console.log('save to cache');
                requestCache[apiParams] = dataset;
                // delete from cache after 1 day
                setTimeout(() => { delete requestCache[apiParams] }, 86400000); // 60*60*24*1000
            }

            return Promise.resolve({ meta: dataset });
        }

        // for group episodes (seasons)
        if(promises.length) {
            Promise.all(promises).then((rArray) => {
                //console.log('Decrypting group data...');
                let videos = [];

                season = rArray.length;

                // foreach group in groups
                for(let r of rArray) {
                    let aesData = aesjs.utils.hex.toBytes(r.data);
                    let aesCbc = new aesjs.ModeOfOperation.cbc(aesKey, aesIv);
                    let result = aesjs.utils.utf8.fromBytes(aesCbc.decrypt(aesData));
                    result = stripJson(result);
                    let resultObj = JSON.parse(result);
                    //console.log(resultObj);

                    // foreach episode in group
                    for(let ep of resultObj.data.episodes) {
                    let episode = ep.name.match(/[0-9]+/g);
                    
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
                            released: new Date(episode),
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

                let dataset = {};
                // check if cache contains this anime
                console.log('does our cache contain this anime?', typeof cache[args.id]);

                if(!cache[args.id]) {
                    console.log('meta cache doesnt contain '+args.id);

                    // TODO: rebuild meta cache on (re)start, or here, when not found
                    dataset = {
                        id: args.id,
                        name: 'undefined',
                        //overview: cache[args.id].overview,
                        description: 'undefined',
                        genres: 'undefined',
                        type: 'series',
                        poster: '',
                        background: '',
                        videos: videos,
                        isPeered: true
                    };
                } else {
                    // build dataset from videos list and our meta cache
                    dataset = {
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
                }

                console.log('save meta to cache');
                requestCache[apiParams] = dataset;
                // delete from cache after 1 day
                setTimeout(() => { delete requestCache[apiParams] }, 86400000); // 60*60*24*1000

                return Promise.resolve({ meta: dataset });
            }).catch((e) => {
                console.log(e.message);
                return Promise.reject(new Error('Error getting episodes'));
            })
        } else {
            console.log('probably not episodes groups cuz promises is undefined');
        }

    }).catch((e) => {
        console.log(e.message);
        return Promise.reject(e);
    })

    console.log('result:',result);
    return result;
})

// Catalog
addon.defineCatalogHandler((args) => {
    console.log('CatalogHandler', args);

    let skip = args.extra.skip ? args.extra.skip : 0;
    let page = skip / 30 + 1;

    let genre = args.extra.genre ? args.extra.genre : 'Most Popular';
    let category = null;
    let search = args.extra.search;

    switch (genre) {
        case 'New and Hot':
            category = 'new_and_hot';
            break;
        case 'Recently Added':
            category = 'recent_addition';
            break;
        case 'Most Popular':
            category = 'most_popular';
            break;
        default:
            genre = genre.replace(/ /g, "-");
            break;
    }

    console.log(genre, category, search);

    let apiParams = '';

    if(category) {
        apiParams = 'action=list&sort='+category+'&page='+page;
    } else if(genre) {
        apiParams = 'action=genre&genre_slug='+ genre +'&page='+page+'&type=slug';
    } else if(search) {
        apiParams = 's='+args.extra.search+'&action=search&page='+page;
    } else {
        throw new Error('No genre nor search query');
    }

    // try to get from cache
    if(requestCache[apiParams]) {
        return { metas: requestCache[apiParams] };
    }

    // get animes and return the returned (pending?) promise
    return axios.put(apiUrl, apiParams, apiOptions).then((r) => {
        //console.log('decrypting response...');
        let aesData = aesjs.utils.hex.toBytes(r.data);
        let aesCbc = new aesjs.ModeOfOperation.cbc(aesKey, aesIv);
        //console.log(r.data);

        let result = aesjs.utils.utf8.fromBytes(aesCbc.decrypt(aesData));

        result = stripJson(result);
        let resultObj = JSON.parse(result);
        //console.log(resultObj);

        let dataset = [];

        if(typeof resultObj.data == "undefined") {
            console.log('Error getting '+args.extra.genre);
            throw new Error('Error, no data from API');
        }

        for(let ani of resultObj.data.anime_list) {
            let genres = ani.genre.split(',');
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
        
        console.log('save catalog to cache');
        requestCache[apiParams] = dataset;
        // delete from cache after 1 day
        setTimeout(() => { delete requestCache[apiParams] }, 86400000); // 60*60*24*1000
        
        return Promise.resolve({ metas: dataset, cacheMaxAge: 300 }); // short cache, otherwise our meta cache doesnt get rebuilt
    })
    .catch((e) => {
        console.log(e.message);
        return Promise.reject(new Error('Error getting catalog'));
    })
})



//if (module.parent) {
    module.exports = addon.getInterface();
//} else {
//    serveHTTP(addon.getInterface(), { port: 7000, cacheMaxAge: 86400 }); // cache 1 day
//}

publishToCentral('https://anime.ers.pw/manifest.json');
