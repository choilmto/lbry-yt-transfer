var express = require('express');
var app = express();

//app.set('port', process.env.port || 8080);
app.disable('x-powered-by');

/*
app.get('/', function(req,res){
    res.send('it works');
});

app.listen(app.get('port'),function(){
    console.log('Web server started! press CTRL+C to terminate');
});*/