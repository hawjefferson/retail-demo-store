// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

const AWS = require('aws-sdk');
const JSONBig = require('json-bigint')({ storeAsString: true });
const mParticle = require('mparticle');
const trackingId = process.env.PERSONALISE_TRACKING_ID;
const campaignArn = process.env.PERSONALISE_CAMPAIGN_ARN;
const report_actions = ["purchase", "view_detail", "add_to_cart", "checkout","add_to_wishlist"];
const mp_api_key = process.env.MPARTICLE_S2S_API_KEY;
const mp_api_secret = process.env.MPARTICLE_S2S_SECRET_KEY;
const personalizeevents = new AWS.PersonalizeEvents({apiVersion: '2018-03-22'});
const personalizeruntime = new AWS.PersonalizeRuntime({apiVersion: '2018-05-22'});
console.log("ENVIRONMENT VARIABLES:"+trackingId+":"+mp_api_key+":"+mp_api_secret);
const mp_api = new mParticle.EventsApi(new mParticle.Configuration(mp_api_key, mp_api_secret));
const req = require('request');
const axios = require('axios');

var eventList = [];
var mpid;

//new file

exports.handler = function (event, context) {

    console.log(event);
    console.log(event.Records);
   // const record = event.Records;
    for (const record of event.Records) {
        const payloadString = Buffer.from(record.kinesis.data, 'base64').toString('ascii');
        console.log(payloadString);
        const payload = JSON.parse(payloadString);
        console.log(payload);
        const events = payload.events;
        mpid = payload.mpid.toString();
        var amazonPersonalizeId = mpid;
        if(payload.user_attributes && payload.user_attributes.amazonPersonalizeId)
            amazonPersonalizeId = payload.user_attributes.amazonPersonalizeId;

        var amazonUserId = mpid;
        if(payload.user_identities){
            for (const identityRecord of payload.user_identities)
            {
                if(identityRecord.identity_type==="customer_id")
                    amazonUserId = identityRecord.identity;
            }
        }
        const sessionId = payload.message_id;
        let params = {
            sessionId: sessionId,
            userId: amazonPersonalizeId,
            trackingId: trackingId
        };
        console.log(params);
        // Check for variant and assign one if not already assigned
        var variant_assigned;
        var variant;
        if(payload.user_attributes && payload.user_attributes.ml_variant)
        {
            variant_assigned = Boolean(payload.user_attributes.ml_variant); 
            variant = variant_assigned ? payload.user_attributes.ml_variant : Math.random() > 0.5 ? "A" : "B";
        }
        console.log(events);
        for (const e of events) {
            if (e.event_type === "commerce_event" && report_actions.indexOf(e.data.product_action.action) >= 0) {
                const timestamp = Math.floor(e.data.timestamp_unixtime_ms / 1000);
                const action = e.data.product_action.action;
                const event_id = e.data.event_id;
                const discount = Math.random() > 0.5 ? "Yes" : "No";
                for (const product of e.data.product_action.products) {
                    const obj = {itemId: product.id,discount: discount};

                    if(eventList.length > 10){
                        eventList.shift();
                        
                    }
                    eventList.push({
                        properties: obj,
                        sentAt: timestamp,
                        eventId: event_id,
                        eventType: action
                    });
                }
            }
        }

        console.log("Event List:");
        console.log(eventList);
        console.log(eventList.length);
        if(eventList.length > 10)
        {
            console.log("eventList more than 10");
            console.log(eventList);
            var lastTenRecords = eventList.length / 2;
            eventList = eventList.slice(lastTenRecords);
            console.log("eventList after slice");
            console.log(eventList);
        }
        if (eventList.length > 0) {
            params.eventList = eventList;
                personalizeevents.putEvents(params, async function(err, data) {
                if (err) 
                {
                    console.log(err);
                    console.log(err, err.stack);
                }
                else {
                    //getProductPersonalization
                    let params = {
                      // Select campaign based on variant
                      campaignArn: campaignArn,
                      numResults: '5',
                      userId: amazonPersonalizeId
                    };
                    console.log(params);
                    personalizeruntime.getRecommendations(params, async function(err, data) {
                      if (err)
                      {
                        console.log(err);
                          console.log(err, err.stack);
                      }
                      else {
                          
                          let batch = new mParticle.Batch(mParticle.Batch.Environment.development);
                          batch.mpid = mpid;
                          let itemList = [];
                          var productNameList = [];
                          let promises = [];
                          for (let item of data.itemList) {
                              itemList.push(item.itemId);
                              var url = "https://products.stridesolution.com/products/id/"+item.itemId;
                              
                              promises.push(axios.get(url));
                              promises.push(
                                axios.get(url).then(response => {
                                  // do something with response
                                  productNameList.push(response.data.name);
                                })
                              );
                          }

                          await Promise.all(promises).then(() => console.log(productNameList));
                          batch.user_attributes = {};
                          batch.user_attributes.product_recs = itemList;
                          console.log("ItemList");
                          console.log(itemList);
                          console.log("poductNameList");
                          console.log(productNameList);
                          // Record variant on mParticle user profile
                          if (!variant_assigned) {
                              batch.user_attributes.ml_variant = variant
                              batch.user_attributes.product_recs_name=productNameList;
                          }
    
                          let event = new mParticle.AppEvent(mParticle.AppEvent.CustomEventType.other, 'AWS Product Personalization Recs Update');
                          event.custom_attributes = {product_recs: itemList.join()};
                          batch.addEvent(event);
                          var body = [batch]; // {[Batch]} Up to 100 Batch objects
                          
                          let mp_callback = async function(error, data, response) {
                              if (error) {
                                  console.error(error);
                                } else {
                                  console.log('API called successfully.');
                                }
                              };
                        
                          mp_api.bulkUploadEvents(body, mp_callback);
                          //uploadEvents(body, batch);
                         // return 'Success';
                      }
                    });
    
                }
            });
        }
    }

    console.log("Successfully processed");
 
   

};