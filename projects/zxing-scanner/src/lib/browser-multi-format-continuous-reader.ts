/// <reference path="./image-capture.d.ts" />

import {
  BrowserMultiFormatReader as ZXingBrowserMultiFormatReader,
  ChecksumException,
  Exception,
  FormatException,
  NotFoundException,
  Result,
} from '@zxing/library';

import {
  BehaviorSubject,
  Observable,
  Subscriber,
  Subscription
} from 'rxjs';

import { catchError } from 'rxjs/operators';
import { startTimeRange } from '@angular/core/src/profile/wtf_impl';

/**
 * Based on zxing-typescript BrowserCodeReader
 */
export class BrowserMultiFormatContinuousReader extends ZXingBrowserMultiFormatReader {

  /**
   * Used to control the decoding stream when it's open.
   */
  protected decodingStream: Subscription;

  /**
   * The track from camera.
   */
  protected track: MediaStreamTrack;

  /**
   * Says if there's a torch available for the current device.
   */
  protected _torchAvailable = new BehaviorSubject<boolean>(undefined);
  nextScanDelayId: NodeJS.Timeout;

  /**
   * Exposes _tochAvailable .
   */
  public get torchAvailable(): Observable<boolean> {
    return this._torchAvailable.asObservable();
  }

  /**
   * The device id of the current media device.
   */
  protected deviceId: string;

  /**
   * Starts the decoding from the current or a new video element.
   *
   * @param done The callback to be executed after every scan attempt
   * @param deviceId The device's to be used Id
   * @param videoElement A new video element
   */
  public async continuousDecodeFromInputVideoDevice(
    done?: (result: Result) => any,
    deviceId?: string,
    videoElement?: HTMLVideoElement
  ): Promise<void> {

    this.stop();

    this.prepareVideoElement(videoElement);

    // Keeps the deviceId between scanner resets.
    if (typeof deviceId !== 'undefined') {
      this.deviceId = deviceId;
    }

    const video = typeof deviceId === 'undefined'
      ? { facingMode: { exact: 'environment' } }
      : { deviceId: { exact: deviceId } };

    const constraints: MediaStreamConstraints = {
      audio: false,
      video
    };

    if (typeof navigator === 'undefined') {
      return;
    }

    let stream: MediaStream;

    try {
      stream = await navigator
        .mediaDevices
        .getUserMedia(constraints);
    } catch (err) {
      /* handle the error, or not */
      console.error(err);
    }


    const observable = this.startDecodeFromStream(stream);

    () => {

      if (this.decodingStream) {
        this.decodingStream.unsubscribe();
      }

      this.decodingStream = this.decodeWithDelay(this.timeBetweenScansMillis)
        .pipe(catchError((e, x) => this.handleDecodeStreamError(e, x)))
        .subscribe((x: Result) => done(x));
    });
  }

  /**
   * Sets the new stream and request a new decoding-with-delay.
   *
   * @param stream The stream to be shown in the video element.
   * @param callbackFn A callback for the decode method.
   *
   * @todo Return Promise<Result>
   */
  protected startDecodeFromStream(stream: MediaStream, callbackFn?: (result: Result) => any): void {
    super.startDecodeFromStream(stream, callbackFn);
    this.checkTorchCompatibility(this.stream);
  }

  /**
   * Checks if the stream supports torch control.
   *
   * @param stream The media stream used to check.
   */
  protected async checkTorchCompatibility(stream: MediaStream): Promise<void> {
    try {
      this.track = stream.getVideoTracks()[0];
      const imageCapture = new ImageCapture(this.track);
      const capabilities = await imageCapture.getPhotoCapabilities();
      const compatible = !!capabilities.torch || ('fillLightMode' in capabilities && capabilities.fillLightMode.length !== 0);
      this._torchAvailable.next(compatible);
    } catch (err) {
      this._torchAvailable.next(false);
    }
  }

  /**
   * Enables and disables the device torch.
   */
  public setTorch(on: boolean): void {

    if (!this._torchAvailable.value) {
      // compatibility not checked yet
      return;
    }

    if (on) {
      this.track.applyConstraints({
        advanced: [<any>{ torch: true }]
      });
    } else {
      // @todo check possibility to disable torch without restart
      this.restart();
    }
  }

  /**
   * Opens a decoding stream.
   */
  protected decodeWithStream(stream: BehaviorSubject<Result>): void {

    if (stream.closed) {
      clearTimeout(this.nextScanDelayId);
      this.nextScanDelayId = undefined;
    }

    let result: Result;

    try {
      result = this.decode();
      stream.next(result);
    } catch (err) {
      stream.error(err);
    }

    const timeout = !result ? 0 : this.timeBetweenScansMillis;
    const next = () => this.decodeWithStream(stream);

    // next decode call
    this.nextScanDelayId = setTimeout(next, timeout);
  }

  /**
   * Administra um erro gerado durante o decode stream.
   */
  protected handleDecodeStreamError(err: Exception, caught: Observable<Result>): Observable<Result> {

    if (
      // scan Failure - found nothing, no error
      err instanceof NotFoundException ||
      // scan Error - found the QR but got error on decoding
      err instanceof ChecksumException ||
      err instanceof FormatException
    ) {
      return caught;
    }

    throw err;
  }

  /**
   * Resets the scanner and it's configurations.
   */
  public stop(): void {

    // stops the camera, preview and scan 🔴

    this.stopStreams();

    if (this.videoElement) {

      // first gives freedon to the element 🕊

      if (typeof this.videoPlayEndedEventListener !== 'undefined') {
        this.videoElement.removeEventListener('ended', this.videoPlayEndedEventListener);
      }

      if (typeof this.videoPlayingEventListener !== 'undefined') {
        this.videoElement.removeEventListener('playing', this.videoPlayingEventListener);
      }

      if (typeof this.videoLoadedMetadataEventListener !== 'undefined') {
        this.videoElement.removeEventListener('loadedmetadata', this.videoLoadedMetadataEventListener);
      }

      // then forgets about that element 😢

      this.unbindVideoSrc(this.videoElement);

      this.videoElement.removeAttribute('src');
      this.videoElement = undefined;
    }

    if (this.imageElement) {

      // first gives freedon to the element 🕊

      if (undefined !== this.videoPlayEndedEventListener) {
        this.imageElement.removeEventListener('load', this.imageLoadedEventListener);
      }

      // then forget about that element 😢

      this.imageElement.src = undefined;
      this.imageElement.removeAttribute('src');
      this.imageElement = undefined;
    }

    // cleans canvas references 🖌

    this.canvasElementContext = undefined;
    this.canvasElement = undefined;
  }

  /**
   * Restarts the scanner.
   */
  protected restart(): void {
    // reset
    // start
    this.continuousDecodeFromInputVideoDevice(undefined, this.deviceId, this.videoElement);
  }


  /**
   * Stops the continuous scan and cleans the stream.
   */
  protected stopStreams(): void {

    super.stopStreams();

    if (this.decodingStream) {
      this.decodingStream.unsubscribe();
    }

  }

}
