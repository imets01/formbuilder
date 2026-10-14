import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { provideHttpClient } from '@angular/common/http';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';

import { MAT_ICON_DEFAULT_OPTIONS } from '@angular/material/icon';

@NgModule({
  declarations: [],
  imports: [
    BrowserModule,
    BrowserAnimationsModule,
    AppRoutingModule,
    AppComponent
  ],
  providers: [
  provideHttpClient(),
  {
    provide: MAT_ICON_DEFAULT_OPTIONS,
    useValue: { fontSet: 'material-symbols-outlined' }
  }
],
  bootstrap: [AppComponent]
})
export class AppModule { }
