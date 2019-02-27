let Service, Characteristic;
const lib = require('./lib/bgh');
const nodeCache = require('node-cache');
const STATUS = "status";

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    homebridge.registerAccessory("homebridge-bgh-smart-stv", "BGH-Smart", BghSmart);
};


function BghSmart(log, config) {
    this.log = log;

    this.name = config.name;
    this.log(this.name);

    this.device = new lib.Device();
    this.device.setHomeId(config.homeId);
    this.device.setDeviceId(config.deviceId);
    this.autoRefreshEnabled = config.autoRefreshEnabled || true;
    this.cacheTTL = config.pollingInterval || 5;

    this.requestTimer;
    this.targetTemperature;
    this.targetMode;

    this.cache = new nodeCache({stdTTL: this.cacheTTL, checkperiod: 2, useClones: false});
    this.temperatureDisplayUnits = Characteristic.TemperatureDisplayUnits.CELSIUS;
    this.informationService = new Service.AccessoryInformation();
    this.thermostatService = new Service.Thermostat(this.name);

    this.init(config);
}

BghSmart.prototype = {
    identify(callback) {
        this.log("Identify requested!");

        callback(null);
    },

    getStatus() {
        this.log.debug("Getting status");
        return this.cache.get(STATUS) || this.getStatusFromDevice();
    },

    getStatusFromDevice(silent) {
        if (!silent) {
            this.log("Getting status from device");
        } else {
            this.log.debug("Getting status from device");
        }

        let MODE = lib.MODE;

        return this.device.getStatus()
            .then(status => {
                let currentState = {
                    temperature: status.temperature,
                    targetTemperature: status.targetTemperature,
                    heatingCoolingState: Characteristic.CurrentHeatingCoolingState.OFF,
                    targetHeatingCoolingState: Characteristic.TargetHeatingCoolingState.OFF,
                    error: null
                };

                switch (status.modeId) {
                    case MODE.COOL:
                        currentState.heatingCoolingState = Characteristic.TargetHeatingCoolingState.COOL;
                        currentState.targetHeatingCoolingState = Characteristic.TargetHeatingCoolingState.COOL;
                        break;
                    case MODE.HEAT:
                        currentState.heatingCoolingState = Characteristic.TargetHeatingCoolingState.HEAT;
                        currentState.targetHeatingCoolingState = Characteristic.TargetHeatingCoolingState.HEAT;
                        break;
                    case MODE.AUTO:
                        currentState.heatingCoolingState = Characteristic.TargetHeatingCoolingState.AUTO;
                        currentState.targetHeatingCoolingState = Characteristic.TargetHeatingCoolingState.AUTO;
                        break;
                }

                this.cache.set(STATUS, currentState);

                this.targetMode = currentState.heatingCoolingState;
                this.targetTemperature = currentState.targetTemperature;

                this.log.debug('Got status', JSON.stringify(currentState));

                return currentState;
            })
            .catch(error => {
                this.log.error("Failed getting status");
                this.log.debug(error);
                this.cache.del(STATUS);

                return {
                    error: error
                }
            })
    },

    setStatusToDevice(mode, temperature) {
        if (this.targetMode !== mode || this.targetTemperature !== temperature) {
            this.log("Changing from currentMode=%s to targetMode=%s, and currentTemperature=%s to targetTemperature=%s", this.targetMode, mode, this.targetTemperature, temperature);

            this.cache.del(STATUS);

            this.targetMode = mode;
            this.targetTemperature = temperature;

            clearTimeout(this.requestTimer);

            let that = this;

            this.requestTimer = setTimeout(() => {
                let targetMode = that.targetMode;
                let targetTemperature = that.targetTemperature;

                that.log("Sending new status to device: targetMode=%s, targetTemperature=%s", targetMode, targetTemperature);

                let MODE = lib.MODE;

                switch (targetMode) {
                    case Characteristic.TargetHeatingCoolingState.OFF:
                        that.device.turnOff();
                        break;
                    case Characteristic.TargetHeatingCoolingState.HEAT:
                        that.device.setMode(targetTemperature, MODE.HEAT);
                        break;
                    case Characteristic.TargetHeatingCoolingState.AUTO:
                        that.device.setMode(targetTemperature, MODE.AUTO);
                        break;
                    case Characteristic.TargetHeatingCoolingState.COOL:
                        that.device.setMode(targetTemperature, MODE.COOL);
                        break;
                    default:
                        that.log.warn("Not handled state:", targetMode);
                        break;
                }

                that.thermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
                    .updateValue(targetMode);

                that.thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState)
                    .updateValue(targetMode);

                that.thermostatService.getCharacteristic(Characteristic.TargetTemperature)
                    .updateValue(targetTemperature);
            }, 2000);
        }
    },

    getCurrentHeatingCoolingState(callback) {
        let status = this.getStatus();
        callback(status.error, status.heatingCoolingState);
    },

    getTargetHeatingCoolingState(callback) {
        let status = this.getStatus();
        callback(status.error, status.targetHeatingCoolingState);
    },

    getCurrentTemperature(callback) {
        let status = this.getStatus();
        callback(status.error, status.temperature);
    },

    getTargetTemperature(callback) {
        let status = this.getStatus();
        callback(status.error, status.targetTemperature);
    },

    getTemperatureDisplayUnits(callback) {
        callback(null, this.temperatureDisplayUnits);
    },

    setTargetHeatingCoolingState(targetMode, callback) {
        this.setStatusToDevice(targetMode, this.targetTemperature)

        callback();
    },

    setTargetTemperature(targetTemperature, callback) {
        this.setStatusToDevice(this.targetMode, targetTemperature);

        callback();
    },

    setTemperatureDisplayUnits(value, callback) {
        this.log("setTemperatureDisplayUnits(%s)", value);
        this.temperatureDisplayUnits = value;
        callback(null);
    },

    async init(config) {
        await this.device.login(config.email, config.password);
        await this.device.getStatus();

        this.informationService.getCharacteristic(Characteristic.Manufacturer).updateValue(this.device.getDeviceManufacturer());
        this.informationService.getCharacteristic(Characteristic.Model).updateValue(this.device.getDeviceModel());
        this.informationService.getCharacteristic(Characteristic.SerialNumber).updateValue(this.device.getSerialNumber());

        if (this.autoRefreshEnabled) {
            this.log.debug("Setting up auto refresh");

            this.cache.on('expired', key => {
                this.log.debug(key, 'expired');

                let status = this.getStatusFromDevice(true);

                if (status && !status.error) {
                    this.thermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(status.heatingCoolingState);
                    this.thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(status.targetHeatingCoolingState);
                    this.thermostatService.getCharacteristic(Characteristic.CurrentTemperature).updateValue(status.temperature);
                    this.thermostatService.getCharacteristic(Characteristic.TargetTemperature).updateValue(status.targetTemperature);
                } else {
                    this.cache.emit('expired', key);
                }
            });

            this.getStatusFromDevice();
        }
    },

    getServices() {
        // Required
        this.thermostatService
            .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
            .on('get', this.getCurrentHeatingCoolingState.bind(this));

        this.thermostatService
            .getCharacteristic(Characteristic.TargetHeatingCoolingState)
            .on('get', this.getTargetHeatingCoolingState.bind(this))
            .on('set', this.setTargetHeatingCoolingState.bind(this));

        this.thermostatService
            .getCharacteristic(Characteristic.CurrentTemperature)
            .on('get', this.getCurrentTemperature.bind(this));

        this.thermostatService
            .getCharacteristic(Characteristic.TargetTemperature)
            .on('get', this.getTargetTemperature.bind(this))
            .on('set', this.setTargetTemperature.bind(this))
            .setProps({
                maxValue: 30,
                minValue: 17,
                minStep: 1
            });

        this.thermostatService
            .getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .on('get', this.getTemperatureDisplayUnits.bind(this))
            .on('set', this.setTemperatureDisplayUnits.bind(this));

        return [this.informationService, this.thermostatService];
    }
};
