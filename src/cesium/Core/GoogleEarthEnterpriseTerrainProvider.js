var when=require('when');
var Credit=require('./Credit');
var defaultValue=require('./defaultValue');
var defined=require('./defined');
var defineProperties=require('./defineProperties');
var DeveloperError=require('./DeveloperError');
var Event=require('./Event');
var GeographicTilingScheme=require('./GeographicTilingScheme');
var GoogleEarthEnterpriseMetadata=require('./GoogleEarthEnterpriseMetadata');
var GoogleEarthEnterpriseTerrainData=require('./GoogleEarthEnterpriseTerrainData');
var HeightmapTerrainData=require('./HeightmapTerrainData');
var JulianDate=require('./JulianDate');
var CesiumMath=require('./Math');
var Rectangle=require('./Rectangle');
var Request=require('./Request');
var RequestState=require('./RequestState');
var RequestType=require('./RequestType');
var Resource=require('./Resource');
var RuntimeError=require('./RuntimeError');
var TaskProcessor=require('./TaskProcessor');
var TileProviderError=require('./TileProviderError');

    'use strict';

    var TerrainState = {
        UNKNOWN : 0,
        NONE : 1,
        SELF : 2,
        PARENT : 3
    };

    var julianDateScratch = new JulianDate();

    function TerrainCache() {
        this._terrainCache = {};
        this._lastTidy = JulianDate.now();
    }

    TerrainCache.prototype.add = function(quadKey, buffer) {
        this._terrainCache[quadKey] = {
            buffer : buffer,
            timestamp : JulianDate.now()
        };
    };

    TerrainCache.prototype.get = function(quadKey) {
        var terrainCache = this._terrainCache;
        var result = terrainCache[quadKey];
        if (defined(result)) {
            delete this._terrainCache[quadKey];
            return result.buffer;
        }
    };

    TerrainCache.prototype.tidy = function() {
        JulianDate.now(julianDateScratch);
        if (JulianDate.secondsDifference(julianDateScratch, this._lastTidy) > 10) {
            var terrainCache = this._terrainCache;
            var keys = Object.keys(terrainCache);
            var count = keys.length;
            for (var i = 0; i < count; ++i) {
                var k = keys[i];
                var e = terrainCache[k];
                if (JulianDate.secondsDifference(julianDateScratch, e.timestamp) > 10) {
                    delete terrainCache[k];
                }
            }

            JulianDate.clone(julianDateScratch, this._lastTidy);
        }
    };

    /**
     * Provides tiled terrain using the Google Earth Enterprise REST API.
     *
     * @alias GoogleEarthEnterpriseTerrainProvider
     * @constructor
     *
     * @param {Object} options Object with the following properties:
     * @param {Resource|String} options.url The url of the Google Earth Enterprise server hosting the imagery.
     * @param {GoogleEarthEnterpriseMetadata} options.metadata A metadata object that can be used to share metadata requests with a GoogleEarthEnterpriseImageryProvider.
     * @param {Ellipsoid} [options.ellipsoid] The ellipsoid.  If not specified, the WGS84 ellipsoid is used.
     * @param {Credit|String} [options.credit] A credit for the data source, which is displayed on the canvas.
     *
     * @see GoogleEarthEnterpriseImageryProvider
     * @see CesiumTerrainProvider
     *
     * @example
     * var geeMetadata = new GoogleEarthEnterpriseMetadata('http://www.earthenterprise.org/3d');
     * var gee = new Cesium.GoogleEarthEnterpriseTerrainProvider({
     *     metadata : geeMetadata
     * });
     *
     * @see {@link http://www.w3.org/TR/cors/|Cross-Origin Resource Sharing}
     */
    function GoogleEarthEnterpriseTerrainProvider(options) {
        options = defaultValue(options, {});

        //>>includeStart('debug', pragmas.debug);
        if (!(defined(options.url) || defined(options.metadata))) {
            throw new DeveloperError('options.url or options.metadata is required.');
        }
        //>>includeEnd('debug');

        var metadata;
        if (defined(options.metadata)) {
            metadata = options.metadata;
        } else {
            var resource = Resource.createIfNeeded(options.url);
            metadata = new GoogleEarthEnterpriseMetadata(resource);
        }

        this._metadata = metadata;
        this._tilingScheme = new GeographicTilingScheme({
            numberOfLevelZeroTilesX : 2,
            numberOfLevelZeroTilesY : 2,
            rectangle : new Rectangle(-CesiumMath.PI, -CesiumMath.PI, CesiumMath.PI, CesiumMath.PI),
            ellipsoid : options.ellipsoid
        });

        var credit = options.credit;
        if (typeof credit === 'string') {
            credit = new Credit(credit);
        }
        this._credit = credit;

        // Pulled from Google's documentation
        this._levelZeroMaximumGeometricError = 40075.16;

        this._terrainCache = new TerrainCache();
        this._terrainPromises = {};
        this._terrainRequests = {};

        this._errorEvent = new Event();

        this._ready = false;
        var that = this;
        var metadataError;
        this._readyPromise = metadata.readyPromise
            .then(function(result) {
                if (!metadata.terrainPresent) {
                    var e = new RuntimeError('The server ' + metadata.url + ' doesn\'t have terrain');
                    metadataError = TileProviderError.handleError(metadataError, that, that._errorEvent, e.message, undefined, undefined, undefined, e);
                    return when.reject(e);
                }

                TileProviderError.handleSuccess(metadataError);
                that._ready = result;
                return result;
            })
            .otherwise(function(e) {
                metadataError = TileProviderError.handleError(metadataError, that, that._errorEvent, e.message, undefined, undefined, undefined, e);
                return when.reject(e);
            });
    }

    defineProperties(GoogleEarthEnterpriseTerrainProvider.prototype, {
        /**
         * Gets the name of the Google Earth Enterprise server url hosting the imagery.
         * @memberof GoogleEarthEnterpriseTerrainProvider.prototype
         * @type {String}
         * @readonly
         */
        url : {
            get : function() {
                return this._metadata.url;
            }
        },

        /**
         * Gets the proxy used by this provider.
         * @memberof GoogleEarthEnterpriseTerrainProvider.prototype
         * @type {Proxy}
         * @readonly
         */
        proxy : {
            get : function() {
                return this._metadata.proxy;
            }
        },

        /**
         * Gets the tiling scheme used by this provider.  This function should
         * not be called before {@link GoogleEarthEnterpriseTerrainProvider#ready} returns true.
         * @memberof GoogleEarthEnterpriseTerrainProvider.prototype
         * @type {TilingScheme}
         * @readonly
         */
        tilingScheme : {
            get : function() {
                //>>includeStart('debug', pragmas.debug);
                if (!this._ready) {
                    throw new DeveloperError('tilingScheme must not be called before the imagery provider is ready.');
                }
                //>>includeEnd('debug');

                return this._tilingScheme;
            }
        },

        /**
         * Gets an event that is raised when the imagery provider encounters an asynchronous error.  By subscribing
         * to the event, you will be notified of the error and can potentially recover from it.  Event listeners
         * are passed an instance of {@link TileProviderError}.
         * @memberof GoogleEarthEnterpriseTerrainProvider.prototype
         * @type {Event}
         * @readonly
         */
        errorEvent : {
            get : function() {
                return this._errorEvent;
            }
        },

        /**
         * Gets a value indicating whether or not the provider is ready for use.
         * @memberof GoogleEarthEnterpriseTerrainProvider.prototype
         * @type {Boolean}
         * @readonly
         */
        ready : {
            get : function() {
                return this._ready;
            }
        },

        /**
         * Gets a promise that resolves to true when the provider is ready for use.
         * @memberof GoogleEarthEnterpriseTerrainProvider.prototype
         * @type {Promise.<Boolean>}
         * @readonly
         */
        readyPromise : {
            get : function() {
                return this._readyPromise;
            }
        },

        /**
         * Gets the credit to display when this terrain provider is active.  Typically this is used to credit
         * the source of the terrain.  This function should not be called before {@link GoogleEarthEnterpriseTerrainProvider#ready} returns true.
         * @memberof GoogleEarthEnterpriseTerrainProvider.prototype
         * @type {Credit}
         * @readonly
         */
        credit : {
            get : function() {
                return this._credit;
            }
        },

        /**
         * Gets a value indicating whether or not the provider includes a water mask.  The water mask
         * indicates which areas of the globe are water rather than land, so they can be rendered
         * as a reflective surface with animated waves.  This function should not be
         * called before {@link GoogleEarthEnterpriseTerrainProvider#ready} returns true.
         * @memberof GoogleEarthEnterpriseTerrainProvider.prototype
         * @type {Boolean}
         */
        hasWaterMask : {
            get : function() {
                return false;
            }
        },

        /**
         * Gets a value indicating whether or not the requested tiles include vertex normals.
         * This function should not be called before {@link GoogleEarthEnterpriseTerrainProvider#ready} returns true.
         * @memberof GoogleEarthEnterpriseTerrainProvider.prototype
         * @type {Boolean}
         */
        hasVertexNormals : {
            get : function() {
                return false;
            }
        },

        /**
         * Gets an object that can be used to determine availability of terrain from this provider, such as
         * at points and in rectangles.  This function should not be called before
         * {@link GoogleEarthEnterpriseTerrainProvider#ready} returns true.  This property may be undefined if availability
         * information is not available.
         * @memberof GoogleEarthEnterpriseTerrainProvider.prototype
         * @type {TileAvailability}
         */
        availability : {
            get : function() {
                return undefined;
            }
        }
    });

    var taskProcessor = new TaskProcessor('decodeGoogleEarthEnterprisePacket', Number.POSITIVE_INFINITY);

    // If the tile has its own terrain, then you can just use its child bitmask. If it was requested using it's parent
    //  then you need to check all of its children to see if they have terrain.
    function computeChildMask(quadKey, info, metadata) {
        var childMask = info.getChildBitmask();
        if (info.terrainState === TerrainState.PARENT) {
            childMask = 0;
            for (var i = 0; i < 4; ++i) {
                var child = metadata.getTileInformationFromQuadKey(quadKey + i.toString());
                if (defined(child) && child.hasTerrain()) {
                    childMask |= (1 << i);
                }
            }
        }

        return childMask;
    }

    /**
     * Requests the geometry for a given tile.  This function should not be called before
     * {@link GoogleEarthEnterpriseTerrainProvider#ready} returns true.  The result must include terrain data and
     * may optionally include a water mask and an indication of which child tiles are available.
     *
     * @param {Number} x The X coordinate of the tile for which to request geometry.
     * @param {Number} y The Y coordinate of the tile for which to request geometry.
     * @param {Number} level The level of the tile for which to request geometry.
     * @param {Request} [request] The request object. Intended for internal use only.
     * @returns {Promise.<TerrainData>|undefined} A promise for the requested geometry.  If this method
     *          returns undefined instead of a promise, it is an indication that too many requests are already
     *          pending and the request will be retried later.
     *
     * @exception {DeveloperError} This function must not be called before {@link GoogleEarthEnterpriseTerrainProvider#ready}
     *            returns true.
     */
    GoogleEarthEnterpriseTerrainProvider.prototype.requestTileGeometry = function(x, y, level, request) {
        //>>includeStart('debug', pragmas.debug)
        if (!this._ready) {
            throw new DeveloperError('requestTileGeometry must not be called before the terrain provider is ready.');
        }
        //>>includeEnd('debug');

        var quadKey = GoogleEarthEnterpriseMetadata.tileXYToQuadKey(x, y, level);
        var terrainCache = this._terrainCache;
        var metadata = this._metadata;
        var info = metadata.getTileInformationFromQuadKey(quadKey);

        // Check if this tile is even possibly available
        if (!defined(info)) {
            return when.reject(new RuntimeError('Terrain tile doesn\'t exist'));
        }

        var terrainState = info.terrainState;
        if (!defined(terrainState)) {
            // First time we have tried to load this tile, so set terrain state to UNKNOWN
            terrainState = info.terrainState = TerrainState.UNKNOWN;
        }

        // If its in the cache, return it
        var buffer = terrainCache.get(quadKey);
        if (defined(buffer)) {
            var credit = metadata.providers[info.terrainProvider];
            return when.resolve(new GoogleEarthEnterpriseTerrainData({
                buffer : buffer,
                childTileMask : computeChildMask(quadKey, info, metadata),
                credits : defined(credit) ? [credit] : undefined,
                negativeAltitudeExponentBias: metadata.negativeAltitudeExponentBias,
                negativeElevationThreshold: metadata.negativeAltitudeThreshold
            }));
        }

        // Clean up the cache
        terrainCache.tidy();

        // We have a tile, check to see if no ancestors have terrain or that we know for sure it doesn't
        if (!info.ancestorHasTerrain) {
            // We haven't reached a level with terrain, so return the ellipsoid
            return when.resolve(new HeightmapTerrainData({
                buffer : new Uint8Array(16 * 16),
                width : 16,
                height : 16
            }));
        } else if (terrainState === TerrainState.NONE) {
            // Already have info and there isn't any terrain here
            return when.reject(new RuntimeError('Terrain tile doesn\'t exist'));
        }

        // Figure out where we are getting the terrain and what version
        var parentInfo;
        var q = quadKey;
        var terrainVersion = -1;
        switch (terrainState) {
            case TerrainState.SELF: // We have terrain and have retrieved it before
                terrainVersion = info.terrainVersion;
                break;
            case TerrainState.PARENT: // We have terrain in our parent
                q = q.substring(0, q.length - 1);
                parentInfo = metadata.getTileInformationFromQuadKey(q);
                terrainVersion = parentInfo.terrainVersion;
                break;
            case TerrainState.UNKNOWN: // We haven't tried to retrieve terrain yet
                if (info.hasTerrain()) {
                    terrainVersion = info.terrainVersion; // We should have terrain
                } else {
                    q = q.substring(0, q.length - 1);
                    parentInfo = metadata.getTileInformationFromQuadKey(q);
                    if (defined(parentInfo) && parentInfo.hasTerrain()) {
                        terrainVersion = parentInfo.terrainVersion; // Try checking in the parent
                    }
                }
                break;
        }

        // We can't figure out where to get the terrain
        if (terrainVersion < 0) {
            return when.reject(new RuntimeError('Terrain tile doesn\'t exist'));
        }

        // Load that terrain
        var terrainPromises = this._terrainPromises;
        var terrainRequests = this._terrainRequests;
        var sharedPromise;
        var sharedRequest;
        if (defined(terrainPromises[q])) { // Already being loaded possibly from another child, so return existing promise
            sharedPromise = terrainPromises[q];
            sharedRequest = terrainRequests[q];
        } else { // Create new request for terrain
            sharedRequest = request;
            var requestPromise = buildTerrainResource(this, q, terrainVersion, sharedRequest).fetchArrayBuffer();

            if (!defined(requestPromise)) {
                return undefined; // Throttled
            }

            sharedPromise = requestPromise
                .then(function(terrain) {
                    if (defined(terrain)) {
                        return taskProcessor.scheduleTask({
                            buffer : terrain,
                            type : 'Terrain',
                            key : metadata.key
                        }, [terrain])
                            .then(function(terrainTiles) {
                                // Add requested tile and mark it as SELF
                                var requestedInfo = metadata.getTileInformationFromQuadKey(q);
                                requestedInfo.terrainState = TerrainState.SELF;
                                terrainCache.add(q, terrainTiles[0]);
                                var provider = requestedInfo.terrainProvider;

                                // Add children to cache
                                var count = terrainTiles.length - 1;
                                for (var j = 0; j < count; ++j) {
                                    var childKey = q + j.toString();
                                    var child = metadata.getTileInformationFromQuadKey(childKey);
                                    if (defined(child)) {
                                        terrainCache.add(childKey, terrainTiles[j + 1]);
                                        child.terrainState = TerrainState.PARENT;
                                        if (child.terrainProvider === 0) {
                                            child.terrainProvider = provider;
                                        }
                                    }
                                }
                            });
                    }

                    return when.reject(new RuntimeError('Failed to load terrain.'));
                });

            terrainPromises[q] = sharedPromise; // Store promise without delete from terrainPromises
            terrainRequests[q] = sharedRequest;

            // Set promise so we remove from terrainPromises just one time
            sharedPromise = sharedPromise
                .always(function() {
                    delete terrainPromises[q];
                    delete terrainRequests[q];
                });
        }

        return sharedPromise
            .then(function() {
                var buffer = terrainCache.get(quadKey);
                if (defined(buffer)) {
                    var credit = metadata.providers[info.terrainProvider];
                    return new GoogleEarthEnterpriseTerrainData({
                        buffer : buffer,
                        childTileMask : computeChildMask(quadKey, info, metadata),
                        credits : defined(credit) ? [credit] : undefined,
                        negativeAltitudeExponentBias: metadata.negativeAltitudeExponentBias,
                        negativeElevationThreshold: metadata.negativeAltitudeThreshold
                    });
                }

                return when.reject(new RuntimeError('Failed to load terrain.'));
            })
            .otherwise(function(error) {
                if (sharedRequest.state === RequestState.CANCELLED) {
                    request.state = sharedRequest.state;
                    return when.reject(error);
                }
                info.terrainState = TerrainState.NONE;
                return when.reject(error);
            });
    };

    /**
     * Gets the maximum geometric error allowed in a tile at a given level.
     *
     * @param {Number} level The tile level for which to get the maximum geometric error.
     * @returns {Number} The maximum geometric error.
     */
    GoogleEarthEnterpriseTerrainProvider.prototype.getLevelMaximumGeometricError = function(level) {
        return this._levelZeroMaximumGeometricError / (1 << level);
    };

    /**
     * Determines whether data for a tile is available to be loaded.
     *
     * @param {Number} x The X coordinate of the tile for which to request geometry.
     * @param {Number} y The Y coordinate of the tile for which to request geometry.
     * @param {Number} level The level of the tile for which to request geometry.
     * @returns {Boolean} Undefined if not supported, otherwise true or false.
     */
    GoogleEarthEnterpriseTerrainProvider.prototype.getTileDataAvailable = function(x, y, level) {
        var metadata = this._metadata;
        var quadKey = GoogleEarthEnterpriseMetadata.tileXYToQuadKey(x, y, level);

        var info = metadata.getTileInformation(x, y, level);
        if (info === null) {
            return false;
        }

        if (defined(info)) {
            if (!info.ancestorHasTerrain) {
                return true; // We'll just return the ellipsoid
            }

            var terrainState = info.terrainState;
            if (terrainState === TerrainState.NONE) {
                return false; // Terrain is not available
            }

            if (!defined(terrainState) || (terrainState === TerrainState.UNKNOWN)) {
                info.terrainState = TerrainState.UNKNOWN;
                if (!info.hasTerrain()) {
                    quadKey = quadKey.substring(0, quadKey.length - 1);
                    var parentInfo = metadata.getTileInformationFromQuadKey(quadKey);
                    if (!defined(parentInfo) || !parentInfo.hasTerrain()) {
                        return false;
                    }
                }
            }

            return true;
        }

        if (metadata.isValid(quadKey)) {
            // We will need this tile, so request metadata and return false for now
            var request = new Request({
                throttle : true,
                throttleByServer : true,
                type : RequestType.TERRAIN
            });
            metadata.populateSubtree(x, y, level, request);
        }
        return false;
    };

    /**
     * Makes sure we load availability data for a tile
     *
     * @param {Number} x The X coordinate of the tile for which to request geometry.
     * @param {Number} y The Y coordinate of the tile for which to request geometry.
     * @param {Number} level The level of the tile for which to request geometry.
     * @returns {undefined|Promise} Undefined if nothing need to be loaded or a Promise that resolves when all required tiles are loaded
     */
    GoogleEarthEnterpriseTerrainProvider.prototype.loadTileDataAvailability = function(x, y, level) {
        return undefined;
    };

    //
    // Functions to handle imagery packets
    //
    function buildTerrainResource(terrainProvider, quadKey, version, request) {
        version = (defined(version) && version > 0) ? version : 1;
        return terrainProvider._metadata.resource.getDerivedResource({
            url: 'flatfile?f1c-0' + quadKey + '-t.' + version.toString(),
            request: request
        });
    }

    module.exports= GoogleEarthEnterpriseTerrainProvider;
