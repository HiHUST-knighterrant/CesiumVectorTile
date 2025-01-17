var defined=require('./defined');

    'use strict';

    var a;

    /**
     * Given a URL, determine whether that URL is considered cross-origin to the current page.
     *
     * @private
     */
    function isCrossOriginUrl(url) {
        if (!defined(a)) {
            a = document.createElement('a');
        }

        // copy window location into the anchor to get consistent results
        // when the port is default for the protocol (e.g. 80 for HTTP)
        a.href = window.location.href;

        // host includes both hostname and port if the port is not standard
        var host = a.host;
        var protocol = a.protocol;

        a.href = url;
        // IE only absolutizes href on get, not set
        a.href = a.href; // eslint-disable-line no-self-assign

        return protocol !== a.protocol || host !== a.host;
    }

    module.exports= isCrossOriginUrl;
