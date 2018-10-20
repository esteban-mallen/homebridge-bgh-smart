let Service, Characteristic;
const lib = require('./lib/bgh');
const nodeCache = require('node-cache');
const STATUS = "status";

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    homebridge.registerAccessory("homebridge-bgh-smart", "BGH-Smart", BghSmart);
};


function BghSmart(log, config) {
    this.log = log;

    this.name = config.name;
    this.log(this.name);

    this.device = new lib.Device();
    this.characteristicManufacturer = this.device.getDeviceManufacturer();
    this.characteristicModel = this.device.getDeviceModel();
    this.characteristicSerialNumber = this.device.getSerialNumber();
    this.device.setHomeId(config.homeId);
    this.device.setDeviceId(config.deviceId);

    let that = this;
    this.device.login(config.email, config.password)
        .then(() => {
            this.device.getStatus()
                .then(data => {
                    that.characteristicManufacturer = that.device.getDeviceManufacturer();
                    that.characteristicModel = that.device.getDeviceModel();
                    that.characteristicSerialNumber = that.device.getSerialNumber();
                })
                .catch(err => {

                })
        }).catch((err) => {
    });

    this.autoRefreshEnabled = config.autoRefreshEnabled | true;
    this.refreshTimer;
    this.requestTimer;
    this.targetTemperature;
    this.targetMode;
    this.cache = new nodeCache({stdTTL: 30, checkPeriod: 5, useClones: false});
    this.temperatureDisplayUnits = Characteristic.TemperatureDisplayUnits.CELSIUS;

    this.thermostatService = new Service.Thermostat(this.name);

    this.autoRefresh();
}

BghSmart.prototype = {
    identify(callback) {
        this.log("Identify requested!");

        callback(null);
    },

    getStatus(callback, silent) {
        this.log.debug("Getting status");

        let status = this.cache.get(STATUS);

        if (status) {
            if (status === "fetching") {
                let that = this;

                setTimeout(() => that.getStatus(callback), 1000);
            } else {
                callback(null, status);
            }
        } else {
            this.getStatusFromDevice(callback, silent);
        }
    },

    getStatusFromDevice(callback, silent) {
        if (!silent) this.log("Getting status from device");

        this.cache.set(STATUS, "fetching");

        let MODE = lib.MODE;

        let currentState = {
            heatingCoolingState: Characteristic.CurrentHeatingCoolingState.OFF,
            targetHeatingCoolingState: Characteristic.TargetHeatingCoolingState.OFF,
            temperature: null,
            targetTemperature: null
        };

        this.device.getStatus()
            .then(status => {
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
                    default:
                        currentState.heatingCoolingState = Characteristic.TargetHeatingCoolingState.OFF;
                        currentState.targetHeatingCoolingState = Characteristic.TargetHeatingCoolingState.OFF;
                        break;
                }

                currentState.temperature = status.temperature;
                currentState.targetTemperature = status.targetTemperature;

                this.cache.set(STATUS, currentState);

                callback(null, currentState);

                this.targetMode = currentState.heatingCoolingState;
                this.targetTemperature = currentState.targetTemperature;
            }).catch(error => {
            callback(error);

            this.log("Failed getting status");
            this.cache.del(STATUS);
        });
    },

    setStatusToDevice(mode, temperature, callback) {
        this.log("Received new status, mode=%s, temperature=%s", mode, temperature);

        this.cache.del(STATUS);

        this.targetMode = mode;
        this.targetTemperature = temperature;

        clearTimeout(this.requestTimer);

        let that = this;

        this.requestTimer = setTimeout(() => {
            let targetMode = that.targetMode;
            let targetTemperature = that.targetTemperature;

            that.log("Setting status to device, targetMode=%s, targetTemperature=%s", targetMode, targetTemperature);

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
                    that.log("Not handled state:", targetMode);
                    break;
            }

            that.thermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
                .updateValue(targetMode);

            that.thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState)
                .updateValue(targetMode);

            that.thermostatService.getCharacteristic(Characteristic.TargetTemperature)
                .updateValue(targetTemperature);
        }, 2000);

        callback(null);
    },

    getCurrentHeatingCoolingState(callback) {
        this.getStatus((error, status) => {
            if (error) {
                callback(error);
            } else {
                callback(null, status.heatingCoolingState);
            }
        });
    },

    getTargetHeatingCoolingState(callback) {
        this.getStatus((error, status) => {
            if (error) {
                callback(error);
            } else {
                callback(null, status.targetHeatingCoolingState);
            }
        });
    },

    getCurrentTemperature(callback) {
        this.getStatus((error, status) => {
            if (error) {
                callback(error);
            } else {
                callback(null, status.temperature);
            }
        });
    },

    getTargetTemperature(callback) {
        this.getStatus((error, status) => {
            if (error) {
                callback(error);
            } else {
                callback(null, status.targetTemperature);
            }
        });
    },

    getTemperatureDisplayUnits(callback) {
        callback(null, this.temperatureDisplayUnits);
    },

    setTargetHeatingCoolingState(targetMode, callback) {
        this.setStatusToDevice(targetMode, this.targetTemperature, callback);
    },

    setTargetTemperature(targetTemperature, callback) {
        this.setStatusToDevice(this.targetMode, targetTemperature, callback);
    },

    setTemperatureDisplayUnits(value, callback) {
        this.log("setTemperatureDisplayUnits(%s)", value);
        this.temperatureDisplayUnits = value;
        callback(null);
    },

    autoRefresh() {
        if (this.autoRefreshEnabled) {
            this.log.debug("Autorefresh triggered");

            clearTimeout(this.refreshTimer);

            this.refreshTimer = setTimeout(function() {
                this.getStatus(function (error, status) {
                    if (!error) {
                        this.thermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(status.heatingCoolingState);
                        this.thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(status.targetHeatingCoolingState);
                        this.thermostatService.getCharacteristic(Characteristic.CurrentTemperature).updateValue(status.temperature);
                        this.thermostatService.getCharacteristic(Characteristic.TargetTemperature).updateValue(status.targetTemperature);
                    }
                }.bind(this), true);

                this.autoRefresh()
            }.bind(this), 60000)
        }
    },

    getServices() {
        let informationService = new Service.AccessoryInformation()
            .setCharacteristic(Characteristic.Manufacturer, this.characteristicManufacturer)
            .setCharacteristic(Characteristic.Model, this.characteristicModel)
            .setCharacteristic(Characteristic.SerialNumber, this.characteristicSerialNumber);

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
            .on('set', this.setTemperatureDisplayUnits.bind(this))
            .setProps({
                maxValue: 0,
                minValue: 0,
                validValues: [0]
            });

        return [informationService, this.thermostatService];
    }
};
