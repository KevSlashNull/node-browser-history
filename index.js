const path = require("path");
const fs = require("fs");
const Database = require("sqlite-async");
const uuidV4 = require("uuid").v4;
const moment = require("moment");

const browsers = require("./browsers");


/**
 * Runs the the proper function for the given browser. Some browsers follow the same standards as
 * chrome and firefox others have their own syntax.
 * Returns an empty array or an array of browser record objects
 * @param paths
 * @param browserName
 * @param historyTimeLength
 * @returns {Promise<array>}
 */
async function getBrowserHistory(paths = [], browserName, historyTimeLength) {
    switch (browserName) {
        case browsers.FIREFOX:
        case browsers.SEAMONKEY:
            return getMozillaBasedBrowserRecords(paths, browserName, historyTimeLength);
        case browsers.CHROME:
        case browsers.OPERA:
        case browsers.TORCH:
        case browsers.VIVALDI:
        case browsers.BRAVE:
        case browsers.EDGE:
            return await getChromeBasedBrowserRecords(paths, browserName, historyTimeLength);

        case browsers.MAXTHON:
            return await getMaxthonBasedBrowserRecords(paths, browserName, historyTimeLength);

        case browsers.SAFARI:
            return await getSafariBasedBrowserRecords(paths, browserName, historyTimeLength);

        case browsers.INTERNETEXPLORER:
            //Only do this on Windows we have to do t his here because the DLL manages this
            if (process.platform !== "win32") {
                return [];
            }
            return await getInternetExplorerBasedBrowserRecords(historyTimeLength);

        default:
            return [];
    }
}

async function getHistoryFromDb(newDbPath, sql, browserName) {
    const db = await Database.open(newDbPath);
    const rows = await db.all(sql);
    let browserHistory = rows.map(row => {
        return {
            title: row.title,
            utc_time: row.last_visit_time,
            url: row.url,
            browser: browserName,
        };
    });
    await db.close();
    return browserHistory;
}

function copyDbAndWalFile(dbPath, fileExtension = 'sqlite') {
    const newDbPath = path.join(process.env.TMP ? process.env.TMP : process.env.TMPDIR, uuidV4() + `.${fileExtension}`);
    const filePaths = {};
    filePaths.db = newDbPath;
    filePaths.dbWal = `${newDbPath}-wal`;
    fs.copyFileSync(dbPath, filePaths.db);
    fs.copyFileSync(dbPath, filePaths.dbWal);
    return filePaths;
}

async function forceWalFileDump(dbPath, newDbPath) {
    const db = await Database.open(newDbPath);

    // If the browser uses a wal file we need to create a wal file with the same filename as our temp database.
    // Call wal checkpoint on it so it dumps to the original database. Finally re-copy the original database into the same temporary database. This will have the good data.
    await db.run("PRAGMA wal_checkpoint(FULL)");
    await db.close();
    fs.copyFileSync(dbPath, newDbPath);
}

function deleteTempFiles(paths) {
    paths.forEach(path => {
        fs.unlinkSync(path);
    });
}

async function getChromeBasedBrowserRecords(paths, browserName, historyTimeLength) {
    console.log(paths);
    console.log('******************************')
    if (!paths || paths.length === 0) {
        return [];
    }
    let newDbPaths = [];
    let browserHistory = [];
    console.log(paths);
    for (let i = 0; i < paths.length; i++) {
        let newDbPath = path.join(process.env.TMP ? process.env.TMP : process.env.TMPDIR, uuidV4() + ".sqlite");
        console.log(paths[i])
        newDbPaths.push(newDbPath);
        let sql = `SELECT title, datetime(last_visit_time/1000000 + (strftime('%s', '1601-01-01')),'unixepoch') last_visit_time, url from urls WHERE DATETIME (last_visit_time/1000000 + (strftime('%s', '1601-01-01')), 'unixepoch')  >= DATETIME('now', '-${historyTimeLength} minutes') group by title, last_visit_time order by last_visit_time`;
        //Assuming the sqlite file is locked so lets make a copy of it
        fs.copyFileSync(paths[i], newDbPath);
        browserHistory.push(await getHistoryFromDb(newDbPath, sql, browserName));
    }
    deleteTempFiles(newDbPaths);
    return browserHistory;
}

async function getMozillaBasedBrowserRecords(paths, browserName, historyTimeLength) {
    if (!paths || paths.length === 0) {
        return [];
    }
    let newDbPaths = [];
    let browserHistory = [];
    for (let i = 0; i < paths.length; i++) {
        const tmpFilePaths = copyDbAndWalFile(paths[i]);
        newDbPaths.push(tmpFilePaths.db);
        let sql = `SELECT title, datetime(last_visit_date/1000000,'unixepoch') last_visit_time, url from moz_places WHERE DATETIME (last_visit_date/1000000, 'unixepoch')  >= DATETIME('now', '-${historyTimeLength} minutes') group by title, last_visit_time order by last_visit_time`;
        await forceWalFileDump(paths[i], tmpFilePaths.db);
        browserHistory.push(await getHistoryFromDb(tmpFilePaths.db, sql, browserName, true));
    }
    deleteTempFiles(newDbPaths);
    return browserHistory;

}

async function getSafariBasedBrowserRecords(paths, browserName, historyTimeLength) {
    if (!paths || paths.length === 0) {
        return [];
    }
    let newDbPaths = [];
    let browserHistory = [];
    for (let i = 0; i < paths.length; i++) {
        const tmpFilePaths = copyDbAndWalFile(paths[i]);
        newDbPaths.push(tmpFilePaths.db);
        let sql = `SELECT i.id, i.url, v.title, v.visit_time FROM history_items i INNER JOIN history_visits v on i.id = v.history_item WHERE DATETIME (v.visit_time + 978307200, 'unixepoch')  >= DATETIME('now', '-${historyTimeLength} + " minutes')`;
        await forceWalFileDump(paths[i], tmpFilePaths.db);
        browserHistory.push(await getHistoryFromDb(tmpFilePaths.db, sql, browserName, true));
    }
    deleteTempFiles(newDbPaths);
    return browserHistory;
}


async function getMaxthonBasedBrowserRecords(paths, browserName, historyTimeLength) {
    let newDbPaths = [];
    let browserHistory = [];
    for (let i = 0; i < paths.length; i++) {
        let sql = `SELECT zlastvisittime last_visit_time, zhost host, ztitle title, zurl url FROM zmxhistoryentry WHERE  Datetime (zlastvisittime + 978307200, 'unixepoch') >= Datetime('now', '-${historyTimeLength} minutes')`;
        browserHistory.push(await getHistoryFromDb(paths[i], sql, browserName, true));
    }
    deleteTempFiles(newDbPaths);
    return browserHistory;
}

/**
 * Gets Firefox history
 * @param historyTimeLength time is in minutes
 * @returns {Promise<array>}
 */
async function getFirefoxHistory(historyTimeLength = 5) {
    browsers.browserDbLocations.firefox = browsers.findPaths(browsers.defaultPaths.firefox, browsers.FIREFOX);
    return getBrowserHistory(browsers.browserDbLocations.firefox, browsers.FIREFOX, historyTimeLength).then(records => {
        return records;
    });
}

/**
 * Gets Seamonkey History
 * @param historyTimeLength time is in minutes
 * @returns {Promise<array>}
 */
function getSeaMonkeyHistory(historyTimeLength = 5) {
    browsers.browserDbLocations.seamonkey = browsers.findPaths(browsers.defaultPaths.seamonkey, browsers.SEAMONKEY);
    return getBrowserHistory(browsers.browserDbLocations.seamonkey, browsers.SEAMONKEY, historyTimeLength).then(records => {
        return records;
    });
}

/**
 * Gets Chrome History
 * @param historyTimeLength time is in minutes
 * @returns {Promise<array>}
 */
async function getChromeHistory(historyTimeLength = 5) {
    browsers.browserDbLocations.chrome = browsers.findPaths(browsers.defaultPaths.chrome, browsers.CHROME);
    return getBrowserHistory(browsers.browserDbLocations.chrome, browsers.CHROME, historyTimeLength).then(records => {
        return records;
    });
}

/**
 * Get Opera History
 * @param historyTimeLength time is in minutes
 * @returns {Promise<array>}
 */
async function getOperaHistory(historyTimeLength = 5) {
    browsers.browserDbLocations.opera = browsers.findPaths(browsers.defaultPaths.opera, browsers.OPERA);
    return getBrowserHistory(browsers.browserDbLocations.opera, browsers.OPERA, historyTimeLength).then(records => {
        return records;
    });
}

/**
 * Get Torch History
 * @param historyTimeLength time is in minutes
 * @returns {Promise<array>}
 */
async function getTorchHistory(historyTimeLength = 5) {
    browsers.browserDbLocations.torch = browsers.findPaths(browsers.defaultPaths.torch, browsers.TORCH);
    return getBrowserHistory(browsers.browserDbLocations.torch, browsers.TORCH, historyTimeLength).then(records => {
        return records;
    });
}

/**
 * Get Brave History
 * @param historyTimeLength time is in minutes
 * @returns {Promise<array>}
 */
async function getBraveHistory(historyTimeLength = 5) {
    browsers.browserDbLocations.brave = browsers.findPaths(browsers.defaultPaths.brave, browsers.BRAVE);
    return getBrowserHistory(browsers.browserDbLocations.brave, browsers.BRAVE, historyTimeLength).then(records => {
        return records;
    });
}

/**
 * Get Safari History
 * @param historyTimeLength time is in minutes
 * @returns {Promise<array>}
 */
async function getSafariHistory(historyTimeLength = 5) {
    browsers.browserDbLocations.safari = browsers.findPaths(browsers.defaultPaths.safari, browsers.SAFARI);
    return getBrowserHistory(browsers.browserDbLocations.safari, browsers.SAFARI, historyTimeLength).then(records => {
        return records;
    });
}

/**
 * Get Maxthon History
 * @param historyTimeLength time is in minutes
 * @returns {Promise<array>}
 */
async function getMaxthonHistory(historyTimeLength = 5) {
    browsers.browserDbLocations.maxthon = browsers.findPaths(browsers.defaultPaths.maxthon, browsers.MAXTHON);
    return getBrowserHistory(browsers.browserDbLocations.maxthon, browsers.MAXTHON, historyTimeLength).then(records => {
        return records;
    });
}

/**
 * Get Vivaldi History
 * @param historyTimeLength time is in minutes
 * @returns {Promise<array>}
 */
async function getVivaldiHistory(historyTimeLength = 5) {
    browsers.browserDbLocations.vivaldi = browsers.findPaths(browsers.defaultPaths.vivaldi, browsers.VIVALDI);
    return getBrowserHistory(browsers.browserDbLocations.vivaldi, browsers.VIVALDI, historyTimeLength).then(records => {
        return records;
    });
}
/**
 * Get Microsoft Edge History
 * @param historyTimeLength time is in minutes
 * @returns {Promise<array>}
 */
async function getMicrosoftEdge(historyTimeLength = 5) {
    browsers.browserDbLocations.edge = browsers.findPaths(browsers.defaultPaths.edge, browsers.EDGE);
    return getBrowserHistory(browsers.browserDbLocations.edge, browsers.EDGE, historyTimeLength).then(records => {
        return records;
    });
}

/**
 * Gets the history for the Specified browsers and time in minutes.
 * Returns an array of browser records.
 * @param historyTimeLength | Integer
 * @returns {Promise<array>}
 */
async function getAllHistory(historyTimeLength = 5) {
    let allBrowserRecords = [];

    browsers.browserDbLocations.firefox = browsers.findPaths(browsers.defaultPaths.firefox, browsers.FIREFOX);
    browsers.browserDbLocations.chrome = browsers.findPaths(browsers.defaultPaths.chrome, browsers.CHROME);
    browsers.browserDbLocations.seamonkey = browsers.findPaths(browsers.defaultPaths.seamonkey, browsers.SEAMONKEY);
    browsers.browserDbLocations.opera = browsers.findPaths(browsers.defaultPaths.opera, browsers.OPERA);
    browsers.browserDbLocations.torch = browsers.findPaths(browsers.defaultPaths.torch, browsers.TORCH);
    browsers.browserDbLocations.brave = browsers.findPaths(browsers.defaultPaths.brave, browsers.BRAVE);
    // browsers.browserDbLocations.safari = browsers.findPaths(browsers.defaultPaths.safari, browsers.SAFARI);
    browsers.browserDbLocations.seamonkey = browsers.findPaths(browsers.defaultPaths.seamonkey, browsers.SEAMONKEY);
    browsers.browserDbLocations.maxthon = browsers.findPaths(browsers.defaultPaths.maxthon, browsers.MAXTHON);
    browsers.browserDbLocations.vivaldi = browsers.findPaths(browsers.defaultPaths.vivaldi, browsers.VIVALDI);
    browsers.browserDbLocations.edge = browsers.findPaths(browsers.defaultPaths.edge, browsers.EDGE);

    allBrowserRecords = allBrowserRecords.concat(await getBrowserHistory(browsers.browserDbLocations.firefox, browsers.FIREFOX, historyTimeLength));
    allBrowserRecords = allBrowserRecords.concat(await getBrowserHistory(browsers.browserDbLocations.seamonkey, browsers.SEAMONKEY, historyTimeLength));
    allBrowserRecords = allBrowserRecords.concat(await getBrowserHistory(browsers.browserDbLocations.chrome, browsers.CHROME, historyTimeLength));
    allBrowserRecords = allBrowserRecords.concat(await getBrowserHistory(browsers.browserDbLocations.opera, browsers.OPERA, historyTimeLength));
    allBrowserRecords = allBrowserRecords.concat(await getBrowserHistory(browsers.browserDbLocations.torch, browsers.TORCH, historyTimeLength));
    allBrowserRecords = allBrowserRecords.concat(await getBrowserHistory(browsers.browserDbLocations.brave, browsers.BRAVE, historyTimeLength));
    // allBrowserRecords = allBrowserRecords.concat(await getBrowserHistory(browsers.browserDbLocations.safari, browsers.SAFARI, historyTimeLength));
    allBrowserRecords = allBrowserRecords.concat(await getBrowserHistory(browsers.browserDbLocations.vivaldi, browsers.VIVALDI, historyTimeLength));
    allBrowserRecords = allBrowserRecords.concat(await getBrowserHistory(browsers.browserDbLocations.seamonkey, browsers.SEAMONKEY, historyTimeLength));
    allBrowserRecords = allBrowserRecords.concat(await getBrowserHistory(browsers.browserDbLocations.maxthon, browsers.MAXTHON, historyTimeLength));
    allBrowserRecords = allBrowserRecords.concat(await getBrowserHistory(browsers.browserDbLocations.edge, browsers.EDGE, historyTimeLength));
    //No Path because this is handled by the dll

    return allBrowserRecords;
}

module.exports = {
    getAllHistory,
    getFirefoxHistory,
    getSeaMonkeyHistory,
    getChromeHistory,
    getOperaHistory,
    getTorchHistory,
    getBraveHistory,
    getSafariHistory,
    getMaxthonHistory,
    getVivaldiHistory,
    getMicrosoftEdge,
};

