# MetricsMonitor

FMDX Webserver Monitor plugin for displaying RDS and RF information, volume, equalizers and spectrum analyzer for FM audio, FM baseband and MPX signal.

<img width="1348" height="662" alt="1d" src="https://github.com/user-attachments/assets/96b5cdd7-ba36-48c4-b206-0ed803d4171d" />
<img width="1177" height="174" alt="image" src="https://github.com/user-attachments/assets/82e85238-e51d-4b99-bccf-e70245c5b85f" />
<img width="1178" height="173" alt="image" src="https://github.com/user-attachments/assets/9d961dc7-fd15-4e52-88a8-6b6680d0cb27" />

## v2.1

- Integration of an oscilloscope (click on MPX Spectrum title in the analyzer!)
- New variable for adjusting the tilt at the sound card input (see configuration options!)
- Sound card reconnect logic built in (Tnx to AmateurAudioDude)

## Important note for this version: 

To use the MPX switching option with an ESP32 TEF receiver, this firmware version must be installed:
https://github.com/Highpoint2000/MetricsMonitor/raw/refs/heads/main/firmware/TEF6686_ESP32_Dev_Beta_%20v2.20.5.zip

## Installation notes

1. [Download](https://github.com/Highpoint2000/MetricsMonitor/releases) the last repository as a zip
2. Unpack all files (MetricsMonitorPlugin.js + MetricsMonitor Folder) to ..fm-dx-webserver-main\plugins\ 
3. Stop or close the fm-dx-webserver
4. Start/Restart the fm-dx-webserver with "npm run webserver / node ." on node.js console, check the console informations
5. Activate the MetricsMonitor plugin in the settings
6. Stop or close the fm-dx-webserver
7. Start/Restart the fm-dx-webserver with "npm run webserver / node ." on node.js console, check the console informations
8. Configure your personal settings in the automatically created metricsmonitor.json (in the folder: ../fm-dx-webserver-main/plugins_configs)
9. Stop or close the fm-dx-webserver
10. Start/Restart the fm-dx-webserver with "npm run webserver" on node.js console, check the console informations

## How do I calibrate the meter display?

1. Adjust the input value if necessary:

   - If the Pilot, MPX, and RDS meters show no signal level, increase the MeterInputCalibration in increments of 5
   - If the meters are in the red zone, decrease the MeterInputCalibration in increments of 5

2. Roughly adjust the meter readings (once via Scale):

   - MeterPilotScale: Adjust this up/down (100/50er steps) until you reach approximately 7 kHz.
   - MeterMPXScale: Adjust this up/down (100/50er steps) until you reach approximately 75 kHz.
   - MeterRDSScale: Adjust this up/down (100/50er steps)until you reach approximately 2.0 kHz.	

3. Fine-tuning (via Calibration):

   - MeterPilotCalibration Display: 7.2 kHz. Target: 6.7 kHz. -> MeterPilotCalibration: -0.5
   - MeterMPXCalibration Display: 78 kHz MPX. Target: 75 kHz. -> MeterMPXCalibration: -3.0
   - MeterRDSCalibration Display: 2.5 kHz RDS. Target: 2.0 kHz. -> MeterRDSCalibration: -0.5
   

## Configuration options

The following variables can be changed in the metricsmonitor.json config file:

    /* Audio & MPX Hardware Settings */	
    "sampleRate": 48000,             //  Enter the supported sample rate of the input audio card here: 48000 for displaying the FM audio spectrum / 96000 for displaying the FM baseband and 192000 for the MPX spectrum. The default is 48000.
    "MPXmode": "off",                //  Configure the MPX behavior of the TEF receiver here: "off" = no MPX output / "on" = always MPX output / "auto" = MPX automatic switching (equalizer and signal meter module in stereo - PILOT/MPX/RDS meter module in mono - spectrum analyzer in mono)
    "MPXStereoDecoder": "off",	     //  Set the switch to "on" if you are decoding the stereo signal from MPX with a stereo decoder. This will enable the optical mono/stereo indicator to function when MPXmode is set to "on". The default setting is "off".          
    "MPXInputCard": "",              //  Configure the sound input exclusive to MPX (e.g., for Linux: "plughw:CARD=Device" or Windows: "Microphone (HD USB Audio Device)")
    "MPXTiltCalibration": 0,         //  Adjust the input slope of the sound card from -1000 µs to 1000 µs (default is 0)
	
    /* Calibration Offsets (Meters) */
    "MeterInputCalibration": 0,      //  Increase or decrease the value as needed to adjust the input for the MPX gauges (Pilot, MPX, RDS). The default value is 0. 
    "MeterPilotCalibration": 0,      //  Calibrate the +/- level value for the Pilot level indicator (default = 0)
    "MeterMPXCalibration": 0,        //  Calibrate the +/- level value for the MPX level indicator (default = 0)
    "MeterRDSCalibration": 0,        //  Calibrate the +/- level value for the RDS level indicator (default = 0)

    /* Meter Scales */
    "MeterPilotScale": 200,          // Scale factor for Pilot deviation (default is 200)
    "MeterMPXScale": 100,            // Scale factor for MPX deviation (default is 100)
    "MeterRDSScale": 650,            // Scale factor for RDS deviation (default is 650)

    /* FFT / Spectrum Settings */
	"fftSize": 512,                  //  Change the frequency sampling rate for the spectrum display. The higher the value (e.g. 1024, 2048, 4096), the better the frequency resolution, but also the higher the CPU load. The default and minimum value is 512.

    /* Spectrum Visuals */
    "SpectrumInputCalibration": 0,   //  Increase or decrease the value as needed to adjust the input for the spectrum. The default value is 0. 
	"SpectrumAttackLevel": 3,        //  Response rate of the spectrum display as the signal increases. The default value is 3.
    "SpectrumDecayLevel": 15;        //  This variable determines the number of frames from which a smoothed spectrum is averaged from the raw spectrum. The larger the value, the stronger the smoothing; the smaller the value, the faster and less pronounced the smoothing. The default is 15.
	"SpectrumSendInterval": 30,      //  Change the sampling frequency of the audio signal. The higher the frame rate (FPS), the more frequent the sampling and the higher the CPU load. The default is 15.
    "SpectrumYOffset": -40,          //  Set the +/- level value for the analyzing curve offset (default = -40)
    "SpectrumYDynamics": 2,          //  Set the +/- level value for the analyzing curve dynamic (peak indication / default = 2)

    /* Meter Gains */
	
	"StereoBoost": 2,                //  If the audio signal is too weak, a gain factor for the audio display can be set here (2 - default).
    "AudioMeterBoost": 1,            //  If the audio signal is too weak, a gain factor for the equalizer display can be set here (1 - default).

    /* Layout & UI */
	
    "MODULE_SEQUENCE": "1,2,0,3,4"   //  Set the module display and order: 0 - Audio + Equalizer / 1 - Audio + PILOT/MPX/RDS / 2 - Spectrum Analyzer / 3 - Audio + Signal Strength / 4 - Signal Analyzer. Single values ​​or comma-separated values ​​can be entered: "0,4" or "4" etc. ("1,2,0,4" - default).
	"CANVAS_SEQUENCE": "2,4",        //  Set the module display and order: 2 - PILOT/MPX/RDS + Spectrum Analyzer / 4 - Signal Strength + Signal Analyzer. Single values ​​or comma-separated values ​​can be entered: "2,4", "4,2", "4" or "2". ("2,4" - default). An empty field hides the MPX/Signal button.
    "LockVolumeSlider": true         //  The locked volume control in the browser can be unlocked if needed, but this will affect the measured values ​​(default is true).
	"EnableSpectrumOnLoad": false    //  Set to true for automatic startup activation for the Spectrum Graph plugin (default is false).

    /* Colors & Peaks */
    "MeterColorSafe": "rgb(0, 255, 0)";       // Change the color here for the safe range of the meter displays. The default is "rgb(0, 255, 0)".
    "MeterColorWarning": "rgb(255, 255,0)";   // Change the color here for the warning range of the meter displays. The default is "rgb(255, 255, 0)".
    "MeterColorDanger": "rgb(255, 0, 0)";     // Change the color here for the danger range of the meter displays. The default is "rgb(255, 0, 0)".
    "PeakMode": "dynamic";                    // To set a custom color for the highest peak, change the setting to "fixed". The default is "dynamic".
    "PeakColorFixed": "rgb(251, 174, 38)";    // Define a custom color here for the highest peak display. The default is "rgb(251, 174, 38)".

After making changes to the metricsmonitor.json script, a server restart is only necessary for selected settings; a browser reload may also be sufficient!

## MPX Equipment

### ESP32 Receiver
Make sure the correct PE5PVB firmware is installed. You can either use the software-based MPX switching ("MPXmode": "auto" or "on") or you can permanently activate the MPX output in the audio settings menu. MPX software switching for ESP32 TEF receivers has been added with the new [BETA firmware v2.20.5](https://github.com/Highpoint2000/MetricsMonitor/raw/refs/heads/main/firmware/TEF6686_ESP32_Dev_Beta_%20v2.20.5.zip). Three modes are available (see configuration options!)

### Headless TEF
If the Headless TEF has a line-level audio output, the MPX output can be permanently enabled via a jumper on the board. It is recommended to output the signal to a 192kHz compatible sound card, which is then configured as "MPXInputCard": "plughw:CARD=Device" (Linux) or : "Microphone (HD USB Audio Device)" (Windows). Normal mono/stereo sound output continues to be handled by the i2s USB sound interface.

### MPX Tool & Co.
Anyone wishing to perform stereo decoding using MPX Tool or similar should use the settings "MPXmode": "on" and "MPXStereoDecoder": "on". This will result in permanent MPX output and stereo signaling on the display.

## Hardware Configuration Recommendations

<img width="320" height="240" alt="Folie1" src="https://github.com/user-attachments/assets/8b9bbe20-3d28-49be-bca0-2f4ac9153915" />
<img width="320" height="240" src="https://github.com/user-attachments/assets/429c8fb2-43ee-4eb1-ae98-06eae1dd0b6f" />
<img width="320" height="240" src="https://github.com/user-attachments/assets/3cdebe6a-6eb6-4f7f-b7ad-364853d55f26" />

You can test the plugin here:

Option 1 - http://highpoint2000.selfhost.de:6080

Option 3 - http://highpoint2000.selfhost.de:8080 

## Display modes (Values ​​for MODULE_SEQUENCE)

### Input: 48 kHz Mono/Stereo

<img width="1431" height="263" alt="2a" src="https://github.com/user-attachments/assets/76a708f3-c7e4-4f07-8a12-61eaab0f3521" />

    1 – MO/ST without PILOT/MPX/RDS    2 – only spectrum to 48 kHz       0 – MO/ST with Equalizer      3 – MO/ST with Signal strength
  
### Input: 48 kHz MPX

<img width="1603" height="290" alt="2b" src="https://github.com/user-attachments/assets/7efff0ca-81cc-4cc2-a0a4-d449a04843f0" />


    1 – Mono without PILOT/MPX/RDS   2 – spectrum to 48 kHz with PILOT    0 – MO/ST with Equalizer      3 – MO/ST with Signal strength

### Input: 96 kHz MPX

<img width="1456" height="260" alt="3a" src="https://github.com/user-attachments/assets/73e84447-d22d-4f30-8724-d65f56567b7e" />


       1 – Mono without MPX/RDS     2 – spectrum to 38 kHz with PILOT     0 – MO/ST with Equalizer      3 – MO/ST with Signal strength

### Input: 192 kHz MPX

<img width="1448" height="266" alt="4a" src="https://github.com/user-attachments/assets/cb3801c3-ed30-4f76-b8f2-4da2e90436fb" />

     1 – Mono with PILOT/MPX/RDS   2 – spectrum to 56 kHz with PILOT/RDS   0 – MO/ST with Equalizer     3 – MO/ST with Signal strength

### Signal Plot

<img width="255" height="190" alt="Signal" src="https://github.com/user-attachments/assets/b148cbe7-b904-42a8-b9ad-6f3a753703bc" />

     4 - activate Signal Plot 

## Important notes

- Press the play button to activate the audio output and equalizer.
- You can quickly switch between modules using the numeric keys. Which numbers are active depends on the number of activated modules. The counting always starts with the first value.
- To avoid distorting the measurement results, the volume control is disabled after the plugin is installed! You can re-enable it via the configuration if needed.
- The function of the modules depends on the input signal and the data rate used:
  0/3 = 48 kHz signal (mono or stereo) is sufficient.
  1 = Signal of at least 96 kHz is required for the pilot tone display; a 192 kHz signal is required for the MPX and RDS displays. For both sampling rates, the receiver must support MPX output (activate via the menu if necessary).
  2 = 48 kHz displays the FM audio spectrum up to 19 kHz, 96 kHz the FM baseband up to 38 kHz, and 192 kHz the MPX spectrum up to 56 kHz. For both sampling rates (96 and 192 kHz), the receiver must support MPX output (activate this via the menu or configuration if necessary).

- The configuration file allows you to switch individual display modules on and off and define the click sequence. The various displays can also be calibrated there.
- Press the CTRL key to select different zoom options in MPX + Signal analysis modes
- Use the oscilloscope to adjust the tilt. Activate it by clicking on the "MPX Spectrum" text in the analyzer.

Compatibility with all hardware components and platforms cannot be guaranteed. The receiver's output volume, as well as the technical characteristics of the hardware components, affect the display behavior and must be taken into account!!!

## Contact

If you have any questions, would like to report problems, or have suggestions for improvement, please feel free to contact me! You can reach me by email at highpoint2000@googlemail.com. I look forward to hearing from you!

<a href="https://www.buymeacoffee.com/Highpoint" target="_blank"><img src="https://tef.noobish.eu/logos/images/buymeacoffee/default-yellow.png" alt="Buy Me A Coffee" ></a>

<details>
<summary>History</summary>

## v2.0

- Using our own program library for spectrum analysis and display calculation -> more resource-efficient and higher measurement accuracy
- New scale variables for PILOT, MPX and RDS (see calibration)
- Automatic detection of the MPX channel
- Fixed issues with relative image paths

## v1.5

- Improved PILOT/MPX/RDS detection
- Corrected faulty spectrum display on smartphone screen
- Separate input control added for spectrum and meter display
- Added custom color adjustments for meter displays and highest peak
- Adjusting the RDS meter scale to the pilot display
- Configuration variables restructured for improved clarity (see configuraion options)
- An automatic backup of the JSON configuration file is created

### v1.4

- Added button with additional MPX/Signal Canvas display (see Configuration Options)
- Added improved FFT support for modern CPUs (see Configuration Options - thanks to AmateurAudioDude)
- Improved PILOT/MPX/RDS detection
- Added startup activation for the Spectrum Graph plugin
- Added MPXBoost to enhance the MPX spectrum (see Configuration Options)
- ESP32 MPX Auto Switching synchronized with Headless TEF command


### v1.3

- Signal diagram with time display and frequency marking added (new module), press CTRL for individual zoom options
- Quick module switching possible using numeric keys
- White border removed from the ECC flag
- Tooltip for module switching revised

### v1.2

- Additional  sound card for only MPX encoding can be activated
- A new variable "ExtStereoDecoder" has been added to also activate the mono/stereo signaling when using a ext. stereo decoder e.q. MPX Tool
- Optimization & fix calibration of level and analysis displays, the values ​​can be individually calibrated in the JSON file
- Volume control can now be activated if needed
- MPX Encode Script for 96/192 kHz sampling under Linux (Thanks to <@840861090375401501> )
- Headless TEF software switching Mono <> Stereo <> MPX
- Various zoom options for analyzer display (press STRG Button for options!)
- Discreet real-time display of measured values ​​above the bar graph display
- MPX Mode display integrated

### v1.1a

- Fixed incorrect display of TA, TP and RDS

### v1.1

- MPX software switching for ESP32 TEF receivers has been added with the new [BETA firmware v2.20.5](https://github.com/Highpoint2000/MetricsMonitor/raw/refs/heads/main/firmware/TEF6686_ESP32_Dev_Beta_%20v2.20.5.zip). Three modes are available (see configuration options!).
- Multiple WebSocket connections revised

### v1.0a

- Unit of measurement corrected at MPX level
- Variables for individually adjusting the spectrum have been added (see Configuration options)

### v1.0

- Three display modes: Audio + PILOT/MPX/RDS spectrum analysis / Audio + equalizer (Switching is done by clicking on the display)
# TEST
