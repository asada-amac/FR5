# -*- coding: utf-8 -*-
from .plugin import FR5SurveyReportPlugin

def classFactory(iface):
    return FR5SurveyReportPlugin(iface)
