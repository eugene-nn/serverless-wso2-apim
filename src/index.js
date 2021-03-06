'use strict';
const wso2apim = require("./2.6.0/wso2apim");
const utils = require('./utils/utils');
const fs = require('fs');
const splitca = require('split-ca');
const { SSL_OP_EPHEMERAL_RSA } = require("constants");
const pluginNameSuffix = '[serverless-wso2-apim] ';

console.log.apply(null);

class Serverless_WSO2_APIM {

  constructor(serverless, options) {
    this.cache = {}
    this.serverless = serverless;
    this.options = options;
    this.cmd = this.serverless.pluginManager.cliCommands.join('|');
    this.hooks = {
      'after:deploy:deploy': this.deploy.bind(this),
      'after:info:info': this.info.bind(this),
      'after:remove:remove': this.remove.bind(this)
    };
  };

  // -----------------------------------------
  // --- WSO2 API Manager version agnostic ---
  // -----------------------------------------

  // for sane code 🍻
  // ----------------
  // * Deals with URL of HTTP requests, so it can handle other versions of WSO2 API Manager too (at high-level)
  // * Acts as a first-mile bridge between Serverless Framework and WSO2 API Manager's dictionary
  // * Use no `console.log()` but use `this.serverless.cli.log()`
  // * Use `throw new Error(err)` when you want the execution to halt!
  // -----------------

  initPluginState() {
    this.wso2APIM = this.serverless.service.custom.wso2apim;
    this.apiDefs = this.wso2APIM.apidefs;
  }

  async deploy() {
    this.initPluginState();
    await this.validateConfig();
    if (!this.wso2APIM.enabled) {
      this.serverless.cli.log(pluginNameSuffix + "WO2APIM is disabled. Skipping..");
      return;
    }
    await this.registerClient();
    await this.generateToken();
    await this.uploadCerts();
    await this.createOrUpdateAPIDefs();
  }
  async info() {
    this.initPluginState();
    await this.validateConfig();
    if (!this.wso2APIM.enabled) {
      this.serverless.cli.log(pluginNameSuffix + "WO2APIM is disabled. Skipping..");
      return;
    }
    await this.registerClient();
    await this.generateToken();
    await this.listAPIDefs();
  }
  async remove() {
    this.initPluginState();
    await this.validateConfig();
    if (!this.wso2APIM.enabled) {
      this.serverless.cli.log(pluginNameSuffix + "WO2APIM is disabled. Skipping..");
      return;
    }
    await this.registerClient();
    await this.generateToken();
    await this.removeAPIDefsAndCerts();
  }

  async splitCertChain(certChainContent) {
    const split = "\n";
    const encoding = "utf8";
    let chain = certChainContent;

    var certs = [];
    if(chain.indexOf("-END CERTIFICATE-") < 0 || chain.indexOf("-BEGIN CERTIFICATE-") < 0){
      throw Error("Incompatible certificate format, make sure it's base64 encoded..");
    }
    chain = chain.split(split);
    var cert = [];
    var _i, _len;
    for (_i = 0, _len = chain.length; _i < _len; _i++) {
      var line = chain[_i];
      if (!(line.length !== 0)) {
        continue;
      }
      cert.push(line);
      if (line.match(/-END CERTIFICATE-/)) {
        certs.push(cert.join(split));
        cert = [];
      }
    }
    return certs;
    }

  async validateConfig() {
    // this.serverless.cli.log(pluginNameSuffix + "Validating configuration..");
    const wso2APIM = this.serverless.service.custom.wso2apim;
    if ((wso2APIM.host == undefined) ||
      (wso2APIM.port == undefined) ||
      (wso2APIM.user == undefined) ||
      (wso2APIM.pass == undefined) ||
      (wso2APIM.apidefs == undefined)) {
      this.serverless.cli.log(pluginNameSuffix + "Validating configuration.. NOT OK");
      throw new Error();
    }
    else {
      this.serverless.cli.log(pluginNameSuffix + "Validating configuration.. OK");
    }
  }

  async registerClient() {
    // this.serverless.cli.log(pluginNameSuffix + "Registering client..");
    const wso2APIM = this.serverless.service.custom.wso2apim;
    try {
      const data = await wso2apim.registerClient(
        "https://" + wso2APIM.host + ":" + wso2APIM.port + "/client-registration/" + wso2APIM.versionSlug + "/register",
        wso2APIM.user,
        wso2APIM.pass
      );
      this.cache.clientId = data.clientId;
      this.cache.clientSecret = data.clientSecret;
      this.serverless.cli.log(pluginNameSuffix + "Registering client.. OK");
    }
    catch (err) {
      this.serverless.cli.log(pluginNameSuffix + "Registering client.. NOT OK");
      throw new Error(err);
    }
  }

  async generateToken() {
    // this.serverless.cli.log(pluginNameSuffix + "Generating temporary token..");
    const wso2APIM = this.serverless.service.custom.wso2apim;
    try {
      const data = await wso2apim.generateToken(
        "https://" + wso2APIM.host + ":" + wso2APIM.port + "/oauth2/token",
        wso2APIM.user,
        wso2APIM.pass,
        this.cache.clientId,
        this.cache.clientSecret,
        "apim:api_create apim:api_publish apim:api_view apim:subscribe apim:tier_view apim:tier_manage apim:subscription_view apim:subscription_block",
      );
      this.cache.accessToken = data.accessToken;
      this.serverless.cli.log(pluginNameSuffix + "Generating temporary token.. OK");
    }
    catch (err) {
      this.serverless.cli.log(pluginNameSuffix + "Generating temporary token.. NOT OK");
      throw new Error(err);
    }
  }


  async listCerts() {

    try {
      this.serverless.cli.log("Retrieving backend certificates..");
      this.cache.certAvailability = [];
      // Loops thru each api definition found in serverless configuration
      for (let apiDef of this.apiDefs) {
        try {
          // certAlias takes the form of <APIName>-<Version>
          var certAliasClob = apiDef.name + "-" + apiDef.version;
          const certData = await wso2apim.isCertUploaded(
            "https://" + this.wso2APIM.host + ":" + this.wso2APIM.port + "/api/am/publisher/" + this.wso2APIM.versionSlug + "/certificates",
            this.cache.accessToken,
            certAliasClob
          );
          //Record certificate availability if found
          this.cache.certAvailability.push({
            apiName: apiDef.name,
            apiVersion: apiDef.version,
            apiContext: apiDef.rootContext,
            backendCertValidUntil: certData.validity.to,
            backendCertStatus: certData.status,
          });
        }
        catch (err) {
          if (err.response.data.code != '404') {
            this.serverless.cli.log("Retrieving backend certificates.. NOT OK for " + `${apiDef.name}` + ", proceeding further.");
          }
          //Record certificate availability if not found
          this.cache.certAvailability.push({
            apiName: apiDef.name,
            apiVersion: apiDef.version,
            apiContext: apiDef.rootContext,
            backendCertValidUntil: "NOT FOUND",
            backendCertStatus: "NOT FOUND",
          });
        }
      }
      this.serverless.cli.log("Retrieving backend certificates.. OK");
      console.table(this.cache.certAvailability);
    }
    catch (err) {
      this.serverless.cli.log("Retrieving backend certificates.. NOT OK");
    }
  }


  async listAPIDefs() {
    if (this.cmd === 'info') {
      // this.serverless.cli.log(pluginNameSuffix + "Retrieving API Definitions..");
    }
    const wso2APIM = this.serverless.service.custom.wso2apim;
    const apiDefs = wso2APIM.apidefs;

    //Retrieve tenantSuffix in case of multi-tenant setup
    if (this.wso2APIM.user.includes("@")) {
      this.cache.tenantSuffix = this.wso2APIM.user.split("@")[1];
    }

    this.cache.deploymentStatus = [];
    // Loops thru each api definition found in serverless configuration
    for (let apiDef of apiDefs) {
      try {
        // Check if API is already deployed using the following combination:
        // It takes the form of <APIName>___<Version>___<RootContext>
        var apiDefClob = apiDef.name + "___" + apiDef.version + "___" + apiDef.rootContext;
        const data = await wso2apim.isAPIDeployed(
          "https://" + wso2APIM.host + ":" + wso2APIM.port + "/api/am/publisher/" + wso2APIM.versionSlug + "/apis",
          this.cache.accessToken,
          apiDef.name,
          apiDef.version,
          apiDef.rootContext
        );

        // Loops thru all deployed api definitions returned from WSO2 API Manager (we need to find exact match out of 1:n results returned)
        this.cache.deployedAPIs = [];
        if (data.list.length > 0) {
          data.list.forEach((deployedAPI) => {
            // Remove /t/* suffix if exists
            var deployedAPIContext = deployedAPI.context;
            if (deployedAPIContext.startsWith("/t/")) {
              deployedAPIContext = deployedAPIContext.split(this.cache.tenantSuffix)[1]
            }
            this.cache.deployedAPIs.push({
              apiId: deployedAPI.id,
              apiClob: deployedAPI.name + "___" + deployedAPI.version + "___" + deployedAPIContext,
              apiStatus: deployedAPI.status
            });
          });
        }

        // Compare apples-to-apples (configured-vs-deployed APIs) and record their deployment status
        if (this.cache.deployedAPIs.some(deployedAPI => deployedAPI.apiClob == apiDefClob)) {
          const apiStatus = this.cache.deployedAPIs.find(deployedAPI => deployedAPI.apiClob == apiDefClob).apiStatus;
          const apiId = this.cache.deployedAPIs.find(deployedAPI => deployedAPI.apiClob == apiDefClob).apiId;
          var invokableAPIURL = null;

          // if API is PUBLISHED then retrieve invokable API URL
          try {
            if (apiStatus == 'PUBLISHED') {
              const data = await wso2apim.listInvokableAPIUrl(
                "https://" + wso2APIM.host + ":" + wso2APIM.port + "/api/am/store/" + wso2APIM.versionSlug + "/apis",
                this.cache.accessToken,
                apiId);
              invokableAPIURL = data.endpointURLs.filter((Url) => { return Url.environmentName == wso2APIM.gatewayEnv })[0].environmentURLs.https;
            }
          }
          catch (err) {
            this.serverless.cli.log(pluginNameSuffix + "An error occurred while retrieving Invokable API URL, proceeding further.");
          }

          this.cache.deploymentStatus.push({
            apiName: apiDef.name,
            apiVersion: apiDef.version,
            apiContext: apiDef.rootContext,
            apiStatus: apiStatus,
            apiId, apiId,
            invokableAPIURL: invokableAPIURL + " 🚀",
          });
        }
        else {
          this.cache.deploymentStatus.push({
            apiName: apiDef.name,
            apiVersion: apiDef.version,
            apiContext: apiDef.rootContext,
            apiStatus: "TO BE CREATED",
            apiId: undefined,
            invokableAPIURL: "TO BE CREATED",
          })
        }
      }
      catch (err) {
        this.serverless.cli.log(pluginNameSuffix + "Retrieving API Definitions.. NOT OK");
        throw new Error(err);
      }
      this.cache.deployedAPIs = [];
    };

    if (this.cmd === 'info') {
      this.serverless.cli.log(pluginNameSuffix + "Retrieving API Definitions.. OK");
      console.table(this.cache.deploymentStatus);
    }
  }

  async detectAndSplitCerts(certChain) {
    var certs = [];
    var certOutput;
    // If certChain is provided as a file (relative to where serverless.yml is located)
    if (certChain.startsWith("file://")) {
      certOutput = fs.readFileSync(certChain.split("file://")[1], "utf8");
      certs = await this.splitCertChain(certOutput);

      return certs;
    }
    // If certChain is provided as an AWS ACM ARN
    else if (certChain.startsWith("arn:aws:acm:")) {
      this.provider = this.serverless.getProvider('aws');
      certOutput = await this.provider.request('ACM', 'getCertificate', {
        CertificateArn: certChain
      });
      if (certOutput) {
        const leafCert = certOutput.Certificate;
        const CAs = certOutput.CertificateChain;
        // Push the leaf certificate to the list
        certs.push(leafCert);
        certs.push(await this.splitCertChain(CAs));

        return certs;
      }
    }

  }

  async saveCert(certContent, certAlias) {
    // Create individual certificate files under /.serverless directory
    const slsDir = this.serverless.config.servicePath + "/.serverless";
    if (certContent && certContent.length > 0) {
      let certFile = slsDir + "/" + certAlias + ".cer";
      fs.writeFileSync(certFile, certContent, 'utf8');
    }
  }


  async uploadCerts() {
    const wso2APIM = this.serverless.service.custom.wso2apim;
    const apiDefs = wso2APIM.apidefs;
    const slsDir = this.serverless.config.servicePath + "/.serverless";
    try {
      // Loops thru each api definition found in serverless configuration
      for (const [i, apiDef] of apiDefs.entries()) {
        // this.serverless.cli.log(pluginNameSuffix + "Uploading backend certificates for " + apiDef.name + "..");

        try {
          // certAlias takes the form of <APIName>___<Version>___<index>
          let certs = await this.detectAndSplitCerts(apiDef.backend.http.certChain);

          // Loop thru all certificates, e.g. Leaf cert, Intermediary CA, Root CA etc
          // Create individual certificate files under /.serverless directory
          if (certs && certs.length > 0) {
            for (let j = 0; j < certs.length; j++) {
            // await certs.reduce(async (cert, j) => {
              let cert = certs[j];
              let certAlias = apiDef.name + "___" + apiDef.version + "___" + j;
              await this.saveCert(cert.toString(), certAlias);

              // Upload Cert to WSO2 API Manager
              try {
                await wso2apim.uploadCert(
                  "https://" + wso2APIM.host + ":" + wso2APIM.port + "/api/am/publisher/" + wso2APIM.versionSlug + "/certificates",
                  this.cache.accessToken,
                  certAlias,
                  slsDir + "/" + certAlias + ".cer",
                  apiDef.backend.http.baseUrl
                );
                this.serverless.cli.log(pluginNameSuffix + "Uploading certificate #" + j + " .. OK");
                await utils.goToSleep(1000);
              }
              catch (err) {
                if (err.response.data && err.response.data.code != '409') {
                  this.serverless.cli.log(pluginNameSuffix + "Uploading certificate #" + j + " .. NOT OK, proceeding further");
                  utils.renderError(err);
                }
              }
            }
            this.serverless.cli.log(pluginNameSuffix + "Uploading backend certificates for " + apiDef.name + ".. OK");
          }
        }
        catch (err) {
          if (err.response.data && err.response.data.code != '409') {
            this.serverless.cli.log(pluginNameSuffix + "Uploading backend certificates for " + apiDef.name + ".. NOT OK, proceeding further.");
          }
        }
      }
    }
    catch (err) {
      throw new Error(err);
    }
  }


  async createOrUpdateAPIDefs() {
    const wso2APIM = this.serverless.service.custom.wso2apim;
    const apiDefs = wso2APIM.apidefs;

    //Retrieve tenantSuffix in case of multi-tenant setup
    if (this.wso2APIM.user.includes("@")) {
      this.cache.tenantSuffix = this.wso2APIM.user.split("@")[1];
    }

    try {
      // By calling listAPIDefs(), we are re-collecting the current deployment status in WSO2 API Manager into this.cache.deploymentStatus
      await this.listAPIDefs();

      // Loop thru this.cache.deploymentStatus array
      // Create API definitions, if they do not exist
      // Update API definitions, if they exist
      for (const [i, api] of this.cache.deploymentStatus.entries()) {
        try {
          //Update
          if (api.apiId !== undefined) {
            // this.serverless.cli.log(pluginNameSuffix + "Updating " + api.apiName + " (" + api.apiId + ")..");
            const data = await wso2apim.updateAPIDef(
              "https://" + wso2APIM.host + ":" + wso2APIM.port + "/api/am/publisher/" + wso2APIM.versionSlug + "/apis",
              wso2APIM.user,
              this.cache.accessToken,
              wso2APIM.gatewayEnv,
              apiDefs[i],
              api.apiId
            );
            this.serverless.cli.log(pluginNameSuffix + "Updating " + api.apiName + " (" + api.apiId + ").. OK");
          }
          //Create
          else {
            // this.serverless.cli.log(pluginNameSuffix + "Creating " + api.apiName + "".."");
            const data = await wso2apim.createAPIDef(
              "https://" + wso2APIM.host + ":" + wso2APIM.port + "/api/am/publisher/" + wso2APIM.versionSlug + "/apis",
              wso2APIM.user,
              this.cache.accessToken,
              wso2APIM.gatewayEnv,
              apiDefs[i]
            );
            this.serverless.cli.log(pluginNameSuffix + "Creating " + api.apiName + ".. OK");
          }
        }
        catch (err) {
          this.serverless.cli.log("Creating / Updating " + `${apiDefs[i].name}` + ".. NOT OK, proceeding further.");
        }
      }

      await utils.goToSleep(3000);

      // By calling listAPIDefs(), we are re-collecting the current deployment status in WSO2 API Manager
      await this.listAPIDefs();

      // Publish or Re-Publish API definitions, based on whether they are in CREATED or PUBLISHED states
      for (const [i, api] of this.cache.deploymentStatus.entries()) {
        try {
          if (api.apiId !== undefined) {
            if (api.apiStatus === 'CREATED') {
              // this.serverless.cli.log(pluginNameSuffix + "Publishing " + api.apiName + " (" + api.apiId + ")..");
            }
            else if (api.apiStatus === 'PUBLISHED') {
              // this.serverless.cli.log(pluginNameSuffix + "Re-publishing " + api.apiName + " (" + api.apiId + ")..");
            }
            const data = await wso2apim.publishAPIDef(
              "https://" + wso2APIM.host + ":" + wso2APIM.port + "/api/am/publisher/" + wso2APIM.versionSlug + "/apis/change-lifecycle",
              this.cache.accessToken,
              api.apiId
            );
            this.serverless.cli.log(pluginNameSuffix + "Publishing / Re-publishing " + api.apiName + " (" + api.apiId + ").. OK");
          }
        }
        catch (err) {
          this.serverless.cli.log(pluginNameSuffix + "Publishing / Re-publishing " + apiDefs[i].name + " (" + api.apiId + ").. NOT OK, proceeding further.");
        }
      }
    }
    catch (err) {
      this.serverless.cli.log(pluginNameSuffix + "Creating / Updating API definitions.. NOT OK");
      throw new Error(err);
    }
    await this.listAPIDefs();
    console.table(this.cache.deploymentStatus);
  }


  async removeAPIDefsAndCerts() {
    const wso2APIM = this.serverless.service.custom.wso2apim;
    const apiDefs = wso2APIM.apidefs;

    //Retrieve tenantSuffix in case of multi-tenant setup
    if (this.wso2APIM.user.includes("@")) {
      this.cache.tenantSuffix = this.wso2APIM.user.split("@")[1];
    }

    try {
      // By calling listAPIDefs(), we are re-collecting the current deployment status in WSO2 API Manager
      await this.listAPIDefs();

      // Loop thru this.cache.deploymentStatus array
      // Delete API definitions, if they exist and there are NO active subscriptions/users
      // It does NOT force delete API definitions, if there are any active subscriptions/users
      for (let api of this.cache.deploymentStatus) {
        try {
          if (api.apiId) {
            // this.serverless.cli.log(pluginNameSuffix + "Deleting " + api.apiId + "..");
            const data = await wso2apim.removeAPIDef(
              "https://" + wso2APIM.host + ":" + wso2APIM.port + "/api/am/publisher/" + wso2APIM.versionSlug + "/apis",
              this.cache.accessToken,
              api.apiId
            );
            this.serverless.cli.log(pluginNameSuffix + "Deleting " + api.apiId + ".. OK");

            // Delete associated backend Certificates, if any
            for (let j = 0; j < 5; j++) {
              try {
                // certAlias takes the form of <APIName>___<Version>___<index>
                // certAliasPrefix contains only <APIName>___<Version>              
                let certAliasPrefix = api.apiName + "___" + api.apiVersion;

                const data = await wso2apim.removeCert(
                  "https://" + wso2APIM.host + ":" + wso2APIM.port + "/api/am/publisher/" + wso2APIM.versionSlug + "/certificates",
                  this.cache.accessToken,
                  certAliasPrefix + "___" + j
                );
                this.serverless.cli.log(pluginNameSuffix + "Deleting certificate #" + j + " for " + api.apiName + ".. OK");
              }
              catch (err) {
                // Ignore Certificate-not-found-for-that-Alias error gracefully
                if (err.response.data && err.response.data.code != '404') {
                  this.serverless.cli.log(pluginNameSuffix + "Deleting certificate #" + j + " for " + api.apiName + ".. NOT OK, proceeding further.");
                }
              }
            }
          }
        }
        catch (err) {
          this.serverless.cli.log(pluginNameSuffix + "Deleting " + api.apiId + ".. NOT OK, proceeding further.");
        }
      };
      this.serverless.cli.log(pluginNameSuffix + "Deleting API definitions.. OK");
    }
    catch(err) {
      this.serverless.cli.log(pluginNameSuffix + "Deleting API defintions.. NOT OK");
      throw new Error(err);
    }
  }

}

module.exports = Serverless_WSO2_APIM;
