// Runs under the node 8 of the TV, started by ytlogd-boot.sh. The page of the
// app has no file access and no luna bridge on youtube.com, so it posts its
// log lines to this server.
// The ES5 check of the build reads this file too, so it stays with var.
/* eslint no-var: off */
/*global require*/
var fs = require('fs');
var http = require('http');
var path = require('path');

var PORT = 18999;
var DIR = '/home/root/ytlogs';
var FILE = path.join(DIR, 'youtube.log');
var MAX_FILE_BYTES = 5 * 1024 * 1024;
var OLD_FILES = 3;
var MAX_BODY_BYTES = 4 * 1024 * 1024;
var ORIGIN = 'https://www.youtube.com';

function oldFile(index) {
  return path.join(DIR, 'youtube.' + index + '.log');
}

function fileSize() {
  return fs.existsSync(FILE) ? fs.statSync(FILE).size : 0;
}

function rotate() {
  for (var i = OLD_FILES - 1; i >= 1; i--) {
    if (fs.existsSync(oldFile(i))) fs.renameSync(oldFile(i), oldFile(i + 1));
  }
  fs.renameSync(FILE, oldFile(1));
}

function write(body) {
  if (fileSize() + body.length > MAX_FILE_BYTES && fileSize() > 0) rotate();
  fs.appendFileSync(FILE, body);
}

if (!fs.existsSync(DIR)) fs.mkdirSync(DIR);

http
  .createServer(function (req, res) {
    function answer(code) {
      res.writeHead(code, { 'Access-Control-Allow-Origin': ORIGIN });
      res.end();
    }

    if (
      req.method !== 'POST' ||
      req.url !== '/log' ||
      req.headers.origin !== ORIGIN
    ) {
      req.resume();
      answer(403);
      return;
    }

    var chunks = [];
    var size = 0;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', function () {
      if (size > MAX_BODY_BYTES) {
        answer(413);
        return;
      }
      write(Buffer.concat(chunks));
      answer(204);
    });
  })
  .listen(PORT, '127.0.0.1');
