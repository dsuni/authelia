
import * as Promise from "bluebird";
import * as request from "request";

import Server from "../../src/lib/Server";
import { UserConfiguration } from "../../src/lib/Configuration";
import { GlobalDependencies } from "../../src/lib/GlobalDependencies";
import * as tmp from "tmp";


const requestp = Promise.promisifyAll(request) as request.Request;
const assert = require("assert");
const speakeasy = require("speakeasy");
const sinon = require("sinon");
const nedb = require("nedb");
const session = require("express-session");
const winston = require("winston");

const PORT = 8050;
const requests = require("./requests")(PORT);

describe("test data persistence", function () {
  let u2f: any;
  let tmpDir: tmp.SynchrounousResult;
  const ldap_client = {
    bind: sinon.stub(),
    search: sinon.stub(),
    on: sinon.spy()
  };
  const ldap = {
    createClient: sinon.spy(function () {
      return ldap_client;
    })
  };

  let config: UserConfiguration;

  before(function () {
    u2f = {
      startRegistration: sinon.stub(),
      finishRegistration: sinon.stub(),
      startAuthentication: sinon.stub(),
      finishAuthentication: sinon.stub()
    };

    const search_doc = {
      object: {
        mail: "test_ok@example.com"
      }
    };

    const search_res = {
      on: sinon.spy(function (event: string, fn: (s: object) => void) {
        if (event != "error") fn(search_doc);
      })
    };

    ldap_client.bind.withArgs("cn=test_ok,ou=users,dc=example,dc=com",
      "password").yields(undefined);
    ldap_client.bind.withArgs("cn=test_nok,ou=users,dc=example,dc=com",
      "password").yields("error");
    ldap_client.search.yields(undefined, search_res);

    tmpDir = tmp.dirSync({ unsafeCleanup: true });
    config = {
      port: PORT,
      ldap: {
        url: "ldap://127.0.0.1:389",
        base_dn: "ou=users,dc=example,dc=com",
        user: "user",
        password: "password"
      },
      session: {
        secret: "session_secret",
        expiration: 50000,
      },
      store_directory: tmpDir.name,
      notifier: {
        gmail: {
          user: "user@example.com",
          pass: "password"
        }
      }
    };
  });

  after(function () {
    tmpDir.removeCallback();
  });

  it("should save a u2f meta and reload it after a restart of the server", function () {
    let server: Server;
    const sign_request = {};
    const sign_status = {};
    const registration_request = {};
    const registration_status = {};
    u2f.startRegistration.returns(Promise.resolve(sign_request));
    u2f.finishRegistration.returns(Promise.resolve(sign_status));
    u2f.startAuthentication.returns(Promise.resolve(registration_request));
    u2f.finishAuthentication.returns(Promise.resolve(registration_status));

    const nodemailer = {
      createTransport: sinon.spy(function () {
        return transporter;
      })
    };
    const transporter = {
      sendMail: sinon.stub().yields()
    };

    const deps = {
      u2f: u2f,
      nedb: nedb,
      nodemailer: nodemailer,
      session: session,
      winston: winston,
      ldapjs: ldap,
      speakeasy: speakeasy
    } as GlobalDependencies;

    const j1 = request.jar();
    const j2 = request.jar();

    return start_server(config, deps)
      .then(function (s) {
        server = s;
        return requests.login(j1);
      })
      .then(function (res) {
        return requests.first_factor(j1);
      })
      .then(function () {
        return requests.u2f_registration(j1, transporter);
      })
      .then(function () {
        return requests.u2f_authentication(j1);
      })
      .then(function () {
        return stop_server(server);
      })
      .then(function () {
        return start_server(config, deps);
      })
      .then(function (s) {
        server = s;
        return requests.login(j2);
      })
      .then(function () {
        return requests.first_factor(j2);
      })
      .then(function () {
        return requests.u2f_authentication(j2);
      })
      .then(function (res) {
        assert.equal(204, res.statusCode);
        server.stop();
        return Promise.resolve();
      })
      .catch(function (err) {
        console.error(err);
        return Promise.reject(err);
      });
  });

  function start_server(config: UserConfiguration, deps: GlobalDependencies): Promise<Server> {
    return new Promise<Server>(function (resolve, reject) {
      const s = new Server();
      s.start(config, deps);
      resolve(s);
    });
  }

  function stop_server(s: Server) {
    return new Promise(function (resolve, reject) {
      s.stop();
      resolve();
    });
  }
});
