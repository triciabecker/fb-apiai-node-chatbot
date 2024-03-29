'use strict';

const apiai = require('apiai');
const config = require('./config');
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const uuid = require('node-uuid');
const request = require('request');
const JSONbig = require('json-bigint');
const async = require('async');


const REST_PORT = (process.env.PORT || 5000);
const APIAI_ACCESS_TOKEN = config.API_AI_CLIENT_ACCESS_TOKEN;
const FB_VERIFY_TOKEN = config.FB_VERIFY_TOKEN;
const FB_PAGE_ACCESS_TOKEN = config.FB_PAGE_TOKEN;

const apiAiService = apiai(APIAI_ACCESS_TOKEN, {language: "en", requestSource: "fb"});
const sessionIds = new Map();

function processEvent(event) {
  var sender = event.sender.id.toString();

  sendTypingOff(sender);

  if ((event.message && event.message.text) || (event.postback && event.postback.payload)) {
      var text = event.message ? event.message.text : event.postback.payload;
      // Handle a text message from this sender

      if (!sessionIds.has(sender)) {
          sessionIds.set(sender, uuid.v1());
      }

      console.log("Text", text);    
      sendTypingOn(sender);

      let apiaiRequest = apiAiService.textRequest(text,
          {
              sessionId: sessionIds.get(sender)
          });

      apiaiRequest.on('response', (response) => {
          if (isDefined(response.result)) {
              let responseText = response.result.fulfillment.speech;
              let responseData = response.result.fulfillment.data;
              let action = response.result.action;
              let contexts = response.result.contexts;
              let parameters = response.result.parameters;

              if (isDefined(responseData) && isDefined(responseData.facebook)) {
                  if (!Array.isArray(responseData.facebook)) {
                      try {
                          console.log('Response as formatted message');
                          sendFBMessage(sender, responseData.facebook);
                      } catch (err) {
                          sendFBMessage(sender, {text: err.message});
                      }
                  } else {
                      responseData.facebook.forEach((facebookMessage) => {
                          try {
                              if (facebookMessage.sender_action) {
                                  console.log('Response as sender action');
                                  sendFBSenderAction(sender, facebookMessage.sender_action);
                              }
                              else {
                                  console.log('Response as formatted message');
                                  sendFBMessage(sender, facebookMessage);
                              }
                          } catch (err) {
                              sendFBMessage(sender, {text: err.message});
                          }
                      });
                  }
              } else if (isDefined(action)) {
              	handleApiAiAction(sender, action, responseText, contexts, parameters);
              } else if (isDefined(responseText)) {
                  console.log('Response as text message');
                  sendFBMessage(sender, responseText);
              }

          }
      });

      apiaiRequest.on('error', (error) => console.error(error));
      apiaiRequest.end();
  }
}

function handleApiAiAction(sender, action, responseText, contexts, parameters) {
  switch (action) {
    case 'hiring-application-details':
      if (isDefined(contexts[0]) && contexts[0].name == 'hiring-apply' && contexts[0].parameters) {
        let user_name = (isDefined(contexts[0].parameters['user-name']) &&
        (contexts[0].parameters['user-name'] !== '') ? contexts[0].parameters['user-name'] : 'No Name Provided.');
        let job_apply = (isDefined(contexts[0].parameters['job-apply']) &&
        (contexts[0].parameters['job-apply'] !== '') ? contexts[0].parameters['job-apply'] : 'No Job Position Provided.');
        let current_job = (isDefined(contexts[0].parameters['current-job']) &&
        (contexts[0].parameters['current-job'] !== '') ? contexts[0].parameters['current-job'] : 'No Previous Job Provided.');  

        let emailContent = 'You have received a job inquiry from ' + user_name + ' for the job ' + job_apply + '. This person is currently a ' + current_job + '.';
        sendEmailMessage('New Job Inquiry', emailContent);
      }
      sendFBMessage(sender, responseText);
      break;
    default:
      //unhandled action, just send back the text
      sendFBMessage(sender, responseText);
    break;
    }
}

function sendFBMessage(recipientId, text) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: text
    }
  }
  callSendAPI(messageData);
}

function sendEmailMessage(emailSubject, content) {
  console.log("The email subject is: " + emailSubject);
  console.log("The email content is: " + content);
  var helper = require('sendgrid').mail;
    
  var from_email = new helper.Email('');
  var to_email = new helper.Email('');
  var subject = emailSubject;
  var content = new helper.Content("text/html", content);
  var mail = new helper.Mail(from_email, subject, to_email, content);

  var sg = require('sendgrid')(config.SENDGRID_API_KEY);
  var request = sg.emptyRequest({
    method: 'POST',
    path: '/v3/mail/send',
    body: mail.toJSON()
  });

  sg.API(request, function(error, response) {
    console.log("Sendgrid Response: " + response);
    console.log("Sendgrid Error: " + error);
    console.log(response.statusCode);
    console.log(response.body);
    console.log(response.headers);
  })

}

function splitResponse(str) {
  if (str.length <= 320) {
      return [str];
  }

  return chunkString(str, 300);
}

function chunkString(s, len) {
  var curr = len, prev = 0;

  var output = [];

  while (s[curr]) {
      if (s[curr++] == ' ') {
          output.push(s.substring(prev, curr));
          prev = curr;
          curr += len;
      }
      else {
          var currReverse = curr;
          do {
              if (s.substring(currReverse - 1, currReverse) == ' ') {
                  output.push(s.substring(prev, currReverse));
                  prev = currReverse;
                  curr = currReverse + len;
                  break;
              }
              currReverse--;
          } while (currReverse > prev)
      }
  }
  output.push(s.substr(prev));
  return output;
}

function sendFBSenderAction(sender, action, callback) {
  setTimeout(() => {
      request({
          url: 'https://graph.facebook.com/v2.6/me/messages',
          qs: {access_token: FB_PAGE_ACCESS_TOKEN},
          method: 'POST',
          json: {
              recipient: {id: sender},
              sender_action: action
          }
      }, (error, response, body) => {
          if (error) {
              console.log('Error sending action: ', error);
          } else if (response.body.error) {
              console.log('Error: ', response.body.error);
          }
          if (callback) {
              callback();
          }
      });
  }, 1000);
}

function sendTypingOn(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_on"
  };

  callSendAPI(messageData);
}

function sendTypingOff(recipientId) {

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_off"
  };

  callSendAPI(messageData);
}

function callSendAPI(messageData) {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: {
      access_token: FB_PAGE_ACCESS_TOKEN
    },
    method: 'POST',
    json: messageData

  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;

      if (messageId) {
        console.log("Successfully sent message with id %s to recipient %s",
          messageId, recipientId);
      } else {
        console.log("Successfully called Send API for recipient %s",
          recipientId);
      }
    } else {
      console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
    }
  });
}

function doSubscribeRequest() {
  request({
          method: 'POST',
          uri: "https://graph.facebook.com/v2.6/me/subscribed_apps?access_token=" + FB_PAGE_ACCESS_TOKEN
      },
      (error, response, body) => {
          if (error) {
              console.error('Error while subscription: ', error);
          } else {
              console.log('Subscription result: ', response.body);
          }
      });
}

function isDefined(obj) {
  if (typeof obj == 'undefined') {
      return false;
  }

  if (!obj) {
      return false;
  }

  return obj != null;
}

const app = express();

app.use(bodyParser.text({type: 'application/json'}));

app.get('/webhook/', (req, res) => {
  if (req.query['hub.verify_token'] == FB_VERIFY_TOKEN) {
      res.send(req.query['hub.challenge']);

      setTimeout(() => {
          doSubscribeRequest();
      }, 3000);
  } else {
      res.send('Error, wrong validation token');
  }
});

app.post('/webhook/', (req, res) => {
  try {
      var data = JSONbig.parse(req.body);

      if (data.entry) {
          let entries = data.entry;
          entries.forEach((entry) => {
              let messaging_events = entry.messaging;
              if (messaging_events) {
                  messaging_events.forEach((event) => {
                      if (event.message) {
                      	processEvent(event);
                      }
                  });
              }
          });
      }

      return res.status(200).json({
          status: "ok"
      });
  } catch (err) {
      return res.status(400).json({
          status: "error",
          error: err
      });
  }

});

app.listen(REST_PORT, () => {
  console.log('Rest service ready on port ' + REST_PORT);
});

doSubscribeRequest();
