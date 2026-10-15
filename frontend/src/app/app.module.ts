import { NgModule, inject, provideAppInitializer } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { provideHttpClient, withInterceptors } from '@angular/common/http';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { AuthService, adminTokenInterceptor } from './services/auth.service';

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
  provideHttpClient(withInterceptors([adminTokenInterceptor])),
  provideAppInitializer(() => inject(AuthService).refresh()),
  {
    provide: MAT_ICON_DEFAULT_OPTIONS,
    useValue: { fontSet: 'material-symbols-outlined' }
  }
],
  bootstrap: [AppComponent]
})
export class AppModule { }
